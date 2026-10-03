# Backpressure and cleanup

A session retains at most 100 events of at most 4 KiB each. HTTP bodies and incoming WebSocket frames are capped at 8 KiB. Compression is disabled. There is no per-client application event queue beyond one bounded Redis batch.

Before sending each frame, the gateway checks `bufferedAmount + frame bytes`. Above 64 KiB it closes with 4008 (`slow_consumer`), then terminates after 500 ms if closure cannot complete. Kernel TCP buffers and `ws` frame overhead are additional memory; the 64 KiB check is not a total resident-memory guarantee. An attachment behind the Redis retention floor instead closes with 4009 (`replay_gap`). The client must reconnect with its processed cursor or recover application state after a gap.

The integration test pauses an actual client's TCP reader, continues publishing 4 KiB events and checks the slow-consumer metric plus connection closure. It does not fake `bufferedAmount`. Control traffic is receive-only: sending application frames closes with 1008. Ping/pong detects an unresponsive peer and keeps idle proxy connections alive.

Every gateway allows at most 1,000 accepted sockets. The capacity check runs again after asynchronous authorization/state retrieval. This limits accepted attachments, not all outstanding handshake/HTTP requests. A hostile deployment still needs admission/rate limits at its network boundary. Session creation is bounded by Redis capacity and expiry, not a per-owner quota.

The tradeoff is disconnecting slow clients rather than retaining arbitrary data in gateway memory. Reliable archival delivery would need a different storage and acknowledgment model.
