# Local load measurement

Measured 2026-10-03T14:27:19.089Z. This is a local demonstration, not a capacity claim.

## Environment

- Host: win32; AMD Ryzen 7 5800H with Radeon Graphics         ; 16 logical CPUs; 31.4 GiB RAM.
- Docker Engine 28.3.0; Docker VM allocation: 4 CPUs / 8331214848 bytes.
- Client Node v24.1.0; container Node v24.21.0.
- Client and all four services run on the same machine; Docker Desktop Linux containers.

## Workload

Run `npm run stack:up`, then `npm run load`. Four sequential rounds; independent session per client; one small timestamp event per second for 15 ticks through the round-robin proxy. Each round waits for cursor 15, then kills A, disconnects every client, writes event 16 on B, and reconnects through the proxy. Recovery time includes Docker kill command overhead and concurrent HTTP writes/handshakes. No warm-up or repeated-trial selection.

| Clients | Delivered/expected | Errors | p50 ms | p95 ms | p99 ms | Events/s | Recovery p95 ms | Recovered | A / B loop p99 ms |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 150/150 | 0 | 27 | 50 | 53 | 10.67 | 1746.91 | 10/10 | 10.56 / 10.74 |
| 50 | 750/750 | 0 | 44 | 72 | 81 | 53.31 | 1806.5 | 50/50 | 10.62 / 11.00 |
| 100 | 1500/1500 | 0 | 55 | 80 | 99 | 106.1 | 1937.29 | 100/100 | 11.44 / 11.07 |
| 250 | 3750/3750 | 0 | 104 | 155 | 194 | 262.74 | 2337.22 | 250/250 | 13.97 / 12.76 |

## Interpretation and limits

Latency includes client scheduling, HTTP publication, Redis and the 50 ms gateway polling interval. Throughput is observed delivery over the timed tick phase; it is workload-limited, not saturation throughput. Event-loop p99 comes from each gateway's Prometheus default histogram snapshot over its process lifetime, not only this round. Recovery includes all clients, including those originally attached to B. Tests use tiny events, one host, no WAN/TLS, no steady-state soak, no Redis failover, and no independent load generator. Four single runs do not establish a production service-level objective. Raw output: [benchmark-results.json](benchmark-results.json).

[Earlier failed setup attempt and the change made](benchmark-attempts.md).
