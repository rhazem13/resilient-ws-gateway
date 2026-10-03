import { cpus, totalmem, platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { issueToken } from '../src/auth.js';
import { Client, session, publish, socketUrl, healthy } from './client.js';
const secret = /^AUTH_SECRET=([a-f0-9]{64})$/m.exec(await readFile('.env', 'utf8'))?.[1];
if (!secret) throw new Error('Run npm run stack:up first');
const proxy = 'http://127.0.0.1:8080', survivor = 'http://127.0.0.1:8082';
function command(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Docker command failed');
  return result.stdout.trim();
}
function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(2));
}
async function round(count: number) {
  let errors = 0;
  const setup = await Promise.allSettled(Array.from({ length: count }, async (_, i) => {
    const token = issueToken(secret!, `load-${count}-${i}`), id = await session(proxy, token);
    const client = new Client(socketUrl(proxy, id), token);
    try { await client.ready(); return { id, token, client }; }
    catch (error) { client.close(); throw error; }
  }));
  const clients = setup.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const setupFailures = setup.filter(result => result.status === 'rejected');
  if (setupFailures.length) {
    for (const record of clients) record.client.close();
    throw new Error(`Connection setup failed for ${setupFailures.length}/${count} clients; no latency result reported`);
  }
  const latency: number[] = [];
  for (const record of clients) record.client.socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as { type: string; data?: string };
    if (message.type === 'event' && message.data) latency.push(Date.now() - Number(message.data));
  });
  const start = performance.now();
  const recoveries: number[] = [];
  try {
    for (let tick = 0; tick < 15; tick++) {
      const target = start + tick * 1000;
      await delay(Math.max(0, target - performance.now()));
      await Promise.all(clients.map(record => publish(proxy, record.id, record.token, String(Date.now())).catch(() => { errors++; })));
    }
    await Promise.all(clients.map(record => record.client.event(15).catch(() => { errors++; })));
    const elapsed = (performance.now() - start) / 1000;
    const metrics = await Promise.all(['8081', '8082'].map(async port => (await (await fetch(`http://127.0.0.1:${port}/metrics`)).text())));
    const lag = metrics.map(text => Number(/^nodejs_eventloop_lag_p99_seconds ([\d.e+-]+)/m.exec(text)?.[1] ?? NaN) * 1000);
    const recoveryStart = performance.now();
    command(['compose', 'kill', '-s', 'SIGKILL', 'gateway-a']);
    for (const record of clients) record.client.close();
    await Promise.all(clients.map(async record => {
      await publish(survivor, record.id, record.token, 'recovery');
      const recovered = await new Client(socketUrl(proxy, record.id, 15), record.token).ready();
      try {
        await recovered.event(16);
        if (recovered.messages[0]?.instance !== 'gateway-b') throw new Error('Expected surviving gateway');
        recoveries.push(performance.now() - recoveryStart);
      } finally { recovered.close(); }
    }).map(promise => promise.catch(() => { errors++; })));
    return { clients: count, delivered: latency.length, expected: count * 15, errors, elapsedSeconds: Number(elapsed.toFixed(2)),
      eventsPerSecond: Number((latency.length / elapsed).toFixed(2)), p50Ms: percentile(latency, .5), p95Ms: percentile(latency, .95), p99Ms: percentile(latency, .99),
      recoveryP95Ms: percentile(recoveries, .95), recovered: recoveries.length, gatewayLagP99Ms: lag };
  } finally {
    for (const record of clients) record.client.close();
    command(['compose', 'start', 'gateway-a']); await healthy('http://127.0.0.1:8081');
  }
}
const results = [];
for (const count of [10,50,100,250]) { const result = await round(count); results.push(result); console.log(JSON.stringify(result)); }
const environment = { date: new Date().toISOString(), host: platform(), cpu: cpus()[0]?.model, hostLogicalCpus: cpus().length,
  hostMemoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)), clientNode: process.version,
  gatewayNode: command(['compose', 'exec', '-T', 'gateway-b', 'node', '--version']),
  docker: command(['version', '--format', '{{.Server.Version}}']), dockerResources: command(['info', '--format', '{{.NCPU}} CPUs / {{.MemTotal}} bytes']) };
await writeFile('docs/benchmark-results.json', JSON.stringify({ environment, results }, null, 2) + '\n');
const rows = results.map(r => `| ${r.clients} | ${r.delivered}/${r.expected} | ${r.errors} | ${r.p50Ms} | ${r.p95Ms} | ${r.p99Ms} | ${r.eventsPerSecond} | ${r.recoveryP95Ms} | ${r.recovered}/${r.clients} | ${r.gatewayLagP99Ms.map(v=>v.toFixed(2)).join(' / ')} |`).join('\n');
await writeFile('docs/benchmark.md', `# Local load measurement\n\nMeasured ${environment.date}. This is a local demonstration, not a capacity claim.\n\n## Environment\n\n- Host: ${environment.host}; ${environment.cpu}; ${environment.hostLogicalCpus} logical CPUs; ${environment.hostMemoryGiB} GiB RAM.\n- Docker Engine ${environment.docker}; Docker VM allocation: ${environment.dockerResources}.\n- Client Node ${environment.clientNode}; container Node ${environment.gatewayNode}.\n- Client and all four services run on the same machine; Docker Desktop Linux containers.\n\n## Workload\n\nRun \`npm run stack:up\`, then \`npm run load\`. Four sequential rounds; independent session per client; one small timestamp event per second for 15 ticks through the round-robin proxy. Each round waits for cursor 15, then kills A, disconnects every client, writes event 16 on B, and reconnects through the proxy. Recovery time includes Docker kill command overhead and concurrent HTTP writes/handshakes. No warm-up or repeated-trial selection.\n\n| Clients | Delivered/expected | Errors | p50 ms | p95 ms | p99 ms | Events/s | Recovery p95 ms | Recovered | A / B loop p99 ms |\n|---|---|---|---|---|---|---|---|---|---|\n${rows}\n\n## Interpretation and limits\n\nLatency includes client scheduling, HTTP publication, Redis and the 50 ms gateway polling interval. Throughput is observed delivery over the timed tick phase; it is workload-limited, not saturation throughput. Event-loop p99 comes from each gateway's Prometheus default histogram snapshot over its process lifetime, not only this round. Recovery includes all clients, including those originally attached to B. Tests use tiny events, one host, no WAN/TLS, no steady-state soak, no Redis failover, and no independent load generator. Four single runs do not establish a production service-level objective. Raw output: [benchmark-results.json](benchmark-results.json).\n`);
if (results.some(r => r.errors || r.delivered !== r.expected || r.recovered !== r.clients)) process.exitCode = 1;
