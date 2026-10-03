import { randomBytes } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
export async function secret() {
  const content = await readFile('.env', 'utf8');
  const result = /^AUTH_SECRET=([a-f0-9]{64})$/m.exec(content)?.[1];
  if (!result) throw new Error('Run npm run stack:up to generate a local credential');
  return result;
}
export function compose(...args) {
  const result = spawnSync('docker', ['compose', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker compose failed (${result.status})`);
}
if (process.argv[1]?.endsWith('stack.mjs')) {
  const command = process.argv[2];
  if (command === 'up') {
    try { await writeFile('.env', `AUTH_SECRET=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await secret();
    compose('up', '-d', '--build', '--wait');
  } else if (command === 'down') compose('down');
  else throw new Error('Expected up or down');
}
