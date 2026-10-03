import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { issueToken } from '../src/auth.js';
import { startGateway } from '../src/gateway.js';
import { Client, session, publish, request, socketUrl, healthy } from '../scripts/client.js';
const proxy = 'http://127.0.0.1:8080', a = 'http://127.0.0.1:8081', b = 'http://127.0.0.1:8082';
let secret: string, alice: string, bob: string;
const clients: Client[] = [];
function connect(base: string, id: string, token = alice, cursor = 0) {
  const client = new Client(socketUrl(base, id, cursor), token); clients.push(client); return client;
}
function compose(...args: string[]) {
  const result = spawnSync('docker', ['compose', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function rejection(base: string, id: string, token: string, status: number, cursor = 0) {
  const client = connect(base, id, token, cursor);
  const result = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No handshake response')), 4000);
    client.socket.once('unexpected-response', (_req, response) => { clearTimeout(timeout); response.resume(); client.close(); resolve(response.statusCode!); });
    client.socket.once('open', () => { clearTimeout(timeout); reject(new Error('Unexpected socket acceptance')); });
  });
  assert.equal(result, status);
}
before(async () => {
  secret = /^AUTH_SECRET=([a-f0-9]{64})$/m.exec(await readFile('.env', 'utf8'))?.[1] ?? '';
  assert.equal(secret.length, 64);
  alice = issueToken(secret, 'alice'); bob = issueToken(secret, 'bob');
  await Promise.all([healthy(a), healthy(b), healthy(proxy)]);
});
after(() => { for (const client of clients) client.close(); });

test('non-sticky setup, ordered live delivery and replay on the other gateway', async () => {
  const id = await session(a, alice);
  const first = await connect(b, id).ready();
  await Promise.all(Array.from({ length: 10 }, (_, i) => publish(a, id, alice, `event-${i}`)));
  await first.event(10);
  assert.deepEqual(first.messages.filter(m => m.type === 'event').map(m => m.seq), [1,2,3,4,5,6,7,8,9,10]);
  first.close(); await first.closed();
  await publish(b, id, alice, 'while-disconnected');
  const second = await connect(a, id, alice, 8).ready();
  assert.deepEqual(second.messages.filter(m => m.type === 'event').map(m => m.seq), [9,10,11]);
  assert.equal(second.messages[0]?.instance, 'gateway-a');
});

test('anonymous, tampered and wrong owner writes / attachments are rejected', async () => {
  const creation = await request(a, '/sessions', alice, { owner: 'bob' });
  assert.equal(creation.status, 201);
  const id = (await creation.json() as { id: string }).id;
  assert.equal((await request(a, '/sessions', undefined)).status, 401);
  assert.equal((await request(b, `/sessions/${id}/events`, bob, { data: 'attack', owner: 'alice' })).status, 403);
  assert.equal((await request(b, `/sessions/${id}/events`, undefined, { data: 'attack' })).status, 401);
  await rejection(b, id, bob, 403);
  await rejection(b, id, `${alice}x`, 401);
  await rejection(b, id, alice, 400, 100);
  const client = await connect(b, id).ready();
  assert.equal(client.messages.filter(m => m.type === 'event').length, 0);
});

test('expired credentials reject attachment and token expiry closes an open socket', async () => {
  const id = await session(a, alice);
  await rejection(b, id, issueToken(secret, 'alice', -1), 401);
  const client = await connect(b, id, issueToken(secret, 'alice', 2)).ready();
  assert.equal(await client.closed(), 4001);
});

test('count and age retention return a replay gap instead of silently losing events', async () => {
  const gateway = await startGateway({ port: 8083, instance: 'retention-test', redisUrl: 'redis://127.0.0.1:6387', secret, maxEvents: 3, replayMs: 300 });
  try {
    const base = 'http://127.0.0.1:8083', id = await session(base, alice);
    for (let i = 0; i < 5; i++) await publish(base, id, alice, 'retained');
    await rejection(base, id, alice, 409);
    const client = await connect(base, id, alice, 2).ready();
    assert.deepEqual(client.messages.filter(m => m.type === 'event').map(m => m.seq), [3,4,5]);
    client.close();
    await delay(350);
    await rejection(base, id, alice, 409, 4);
    await connect(base, id, alice, 5).ready();
  } finally { await gateway.close(); }
});

test('session expiration rejects reconnect and closes an existing attachment', async () => {
  const gateway = await startGateway({ port: 8083, instance: 'expiry-test', redisUrl: 'redis://127.0.0.1:6387', secret, sessionMs: 700 });
  try {
    const base = 'http://127.0.0.1:8083', id = await session(base, alice);
    const client = await connect(base, id).ready();
    assert.equal(await client.closed(), 4004);
    await rejection(base, id, alice, 404);
    assert.equal((await request(base, `/sessions/${id}/events`, alice, { data: 'late' })).status, 404);
  } finally { await gateway.close(); }
});

test('concurrent owners cannot leak events across sessions', async () => {
  const tokens = Array.from({ length: 12 }, (_, i) => issueToken(secret, `owner-${i}`));
  const records = await Promise.all(tokens.map(async (token, i) => {
    const id = await session(proxy, token), client = await connect(proxy, id, token).ready();
    await publish(proxy, id, token, `private-${i}`);
    await client.event(1);
    return { id, client, token, i };
  }));
  for (const record of records) {
    assert.deepEqual(record.client.messages.filter(m => m.type === 'event').map(m => m.data), [`private-${record.i}`]);
    await rejection(proxy, record.id, tokens[(record.i + 1) % tokens.length]!, 403);
  }
});

test('SIGKILL of A recovers through the non-sticky proxy on B with bounded replay', async () => {
  const id = await session(a, alice), client = await connect(a, id).ready();
  await publish(b, id, alice, 'before-kill'); await client.event(1);
  try {
    compose('kill', '-s', 'SIGKILL', 'gateway-a');
    assert.equal(await client.closed(), 1006);
    await publish(b, id, alice, 'during-reconnect');
    const recovered = await connect(proxy, id, alice, 1).ready();
    assert.equal(recovered.messages[0]?.instance, 'gateway-b');
    assert.deepEqual(recovered.messages.filter(m => m.type === 'event').map(m => m.seq), [2]);
  } finally { compose('start', 'gateway-a'); await healthy(a); }
});

test('SIGTERM closes sockets with restart semantics and preserves Redis state', async () => {
  const id = await session(a, alice), client = await connect(a, id).ready();
  await publish(a, id, alice, 'persisted'); await client.event(1);
  try {
    compose('stop', '-t', '5', 'gateway-a');
    assert.equal(await client.closed(), 1012);
    const recovered = await connect(b, id).ready();
    assert.equal(recovered.messages.find(m => m.type === 'event')?.data, 'persisted');
  } finally { compose('start', 'gateway-a'); await healthy(a); }
});

test('Redis outage fails writes, terminates attachments, then recovers without local fallback', async () => {
  const id = await session(b, alice), client = await connect(b, id).ready();
  try {
    compose('stop', '-t', '1', 'redis');
    assert.equal((await request(b, `/sessions/${id}/events`, alice, { data: 'not-accepted' })).status, 503);
    assert.equal(await client.closed(), 1013);
    await rejection(b, id, alice, 503);
  } finally { compose('start', 'redis'); await healthy(b); }
  const recovered = await connect(b, id).ready();
  assert.equal(recovered.messages.filter(m => m.type === 'event').length, 0);
  assert.equal(await publish(b, id, alice, 'after-recovery'), 1);
});

test('a paused TCP reader is disconnected once the bounded socket queue fills', async () => {
  const id = await session(b, alice), client = await connect(b, id).ready();
  client.socket.pause();
  for (let round = 0; round < 100; round++) {
    await Promise.all(Array.from({ length: 16 }, () => publish(b, id, alice, 'x'.repeat(4096))));
    await delay(55);
    const metrics = await (await fetch(`${b}/metrics`)).text();
    if (/websocket_failures_total\{reason="slow_consumer"\} [1-9]/.test(metrics)) break;
    if (round === 99) assert.fail('Slow consumer was not disconnected');
  }
  client.socket.resume();
  assert.ok([4008, 1006].includes((await client.closed())!));
});
