import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from '@prometheus-io/client';
export function metrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const connections = new Gauge({ name: 'websocket_connections_current', help: 'Open sockets on this gateway', registers: [registry] });
  const accepted = new Counter({ name: 'websocket_connections_total', help: 'Accepted socket upgrades', registers: [registry] });
  const replayed = new Counter({ name: 'replayed_events_total', help: 'Events sent during initial replay', registers: [registry] });
  const failures = new Counter({ name: 'websocket_failures_total', help: 'Connection termination by bounded reason', labelNames: ['reason'], registers: [registry] });
  const redisDuration = new Histogram({ name: 'redis_operation_duration_seconds', help: 'Redis operation latency including failures', registers: [registry], buckets: [.001, .005, .01, .05, .1, .5, 1, 2] });
  return { registry, connections, accepted, replayed, failures, redisDuration };
}
