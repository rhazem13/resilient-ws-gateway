import { startGateway } from './gateway.js';
const gateway = await startGateway({ port: Number(process.env.PORT ?? 8080), instance: process.env.INSTANCE ?? 'local',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', secret: process.env.AUTH_SECRET ?? '' });
console.log('gateway_listening');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void gateway.close().then(() => { process.exitCode = 0; }).catch(() => { console.error('shutdown_failed'); process.exitCode = 1; });
});
