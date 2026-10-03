# Earlier benchmark attempt

The first attempt on 3 October 2026 completed the 10, 50 and 100 client rounds, then aborted during the 250-client setup burst with `Client condition timed out` (one rejected setup task had index 226). No 250-client latency/capacity result was produced. The first script also failed to save partial results on setup failure; the observed output is preserved below.

| Clients | Delivered | Errors | p50 / p95 / p99 ms | Recovery p95 ms | Recovered |
|---|---|---|---|---|---|
| 10 | 150/150 | 0 | 36 / 56 / 59 | 1741.49 | 10/10 |
| 50 | 750/750 | 0 | 46 / 73 / 77 | 1813.12 | 50/50 |
| 100 | 1500/1500 | 0 | 55 / 91 / 101 | 1924.29 | 100/100 |
| 250 | Setup failed | Unmeasured | Unmeasured | Unmeasured | Unmeasured |

The proxy's empty `events` block was replaced with an explicit 2,048 worker-connection budget. A proxied WebSocket consumes a client and an upstream connection; concurrent HTTP publication requires more. The complete four-level rerun passed. This does not isolate every cause of the first timeout: the run also included gateway recovery and local Docker/network scheduling effects. It would take additional controlled runs to attribute the failure precisely.

The load tool now closes successful and unsuccessful clients when setup fails instead of leaving sockets alive while an error escapes. [Complete rerun](benchmark.md).
