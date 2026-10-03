# Replay semantics

Events belong to one session. Redis assigns an increasing integer cursor in the same Lua script that appends the event. Concurrent publishers on different gateways are ordered by Redis execution, not by their local clocks or HTTP completion times. There is no ordering across sessions.

The stream keeps at most 100 events, each no older than 60 seconds when read. Session metadata and history expire ten minutes after creation; reads and writes do not extend that lifetime. Redis's clock decides event age and key expiry. Reading a batch also removes expired entries. There is no separate cleanup worker.

Clients reconnect with the highest cursor they have **processed**, using the same authenticated identity. A cursor below the retained floor fails the handshake with HTTP 409 (`replay_gap`). A cursor ahead of the sequence fails with 400. Missing or expired sessions return 404. There is no silent jump to the newest event. Clients must recover their application state elsewhere, or start a new session, after a gap.

Each attachment reads a snapshot and then polls from its last sent cursor every 50 ms. There is no switch from replay to a separate pub/sub channel, so an event appended during attachment cannot disappear between those two mechanisms. If the producer outruns retention, the attachment closes with 4009.

Sending is not acknowledgment of processing. A client that processes cursor 12 but reconnects with cursor 11 receives 12 again. Deduplicate by `(session, cursor)`. This is at-least-once replay **within available history**, not exactly-once delivery. An HTTP timeout can also leave publication outcome unknown; retrying may create another event because publication has no idempotency key.

Redis serializes the scripts; it does not provide general transaction rollback on script errors. This demo uses one Redis instance with AOF's default every-second fsync. Losing that instance, its volume, or recently unflushed writes can lose acknowledged events. Gateway failover tests establish process recovery while Redis survives, not durable database failover.

Unbounded retention would turn this into a durable event service. Pub/sub alone would miss disconnected clients. Consumer groups are useful for competing workers but do not match multiple independent session attachments. A bounded stream and explicit gap response keep the scope understandable.

Implementation: [store.ts](../src/store.ts). Behavior: [integration tests](../tests/integration.test.ts).
