import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { issueToken } from '../src/auth.js';
import { Client, session, publish, socketUrl, healthy } from './client.js';
function docker(...args: string[]) {
  const result = spawnSync('docker', ['compose', ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Docker command failed');
}
const startup = spawnSync(process.execPath, ['scripts/stack.mjs', 'up'], { stdio: 'inherit' });
if (startup.status !== 0) throw new Error('Stack startup failed');
const secret = /^AUTH_SECRET=([a-f0-9]{64})$/m.exec(await readFile('.env', 'utf8'))?.[1];
if (!secret) throw new Error('Missing local credential');
const token = issueToken(secret, 'failure-demo');
const proxy = 'http://127.0.0.1:8080';
const id = await session(proxy, token);
const first = await new Client(socketUrl(proxy, id), token).ready();
const instance = first.messages[0]?.instance;
if (instance !== 'gateway-a' && instance !== 'gateway-b') throw new Error('Unknown gateway identity');
const survivor = instance === 'gateway-a' ? 'http://127.0.0.1:8082' : 'http://127.0.0.1:8081';
let recovered: Client | undefined;
try {
  console.log(`Connected through proxy to ${instance}`);
  await publish(proxy, id, token, 'before failure'); await first.event(1);
  console.log('Received cursor 1');
  docker('kill', '-s', 'SIGKILL', instance);
  assert.equal(await first.closed(), 1006);
  await publish(survivor, id, token, 'written while disconnected');
  recovered = await new Client(socketUrl(proxy, id, 1), token).ready();
  assert.notEqual(recovered.messages[0]?.instance, instance);
  assert.deepEqual(recovered.messages.filter(m => m.type === 'event').map(m => m.seq), [2]);
  console.log(`Reconnected through proxy to ${recovered.messages[0]?.instance}; replayed cursor 2`);
} finally {
  first.close(); recovered?.close(); docker('start', instance);
  await healthy(instance === 'gateway-a' ? 'http://127.0.0.1:8081' : 'http://127.0.0.1:8082');
}
