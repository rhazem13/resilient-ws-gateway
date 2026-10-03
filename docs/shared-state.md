# Shared and local state

Redis holds session owner, expiry, sequence and bounded stream entries. Gateways hold sockets and their current delivery cursors. Restarting a gateway discards no authoritative session state. The two session keys use the same hash tag, although this stack does not run or validate Redis Cluster.

An authenticated Node client sends a short-lived HMAC bearer token in the HTTP Authorization header, including during WebSocket upgrade. The subject comes from signature verification, never request-body owner fields. Every stream read and append checks the stored owner inside Redis. Knowing a session UUID is insufficient to attach. Token expiry also closes an existing attachment.

The local stack generates an ignored random credential once. Demo and load scripts issue test identities with it; there is no public token-minting endpoint. This is an explicit trusted-issuer demonstration, not an OAuth implementation. Browser WebSocket clients cannot set this header directly; a browser-facing deployment would need a separately designed credential exchange. Never put bearer credentials in query strings.

During Redis unavailability, HTTP state operations return 503. Attachments close with 1013 and `state_unavailable` after the next failed poll. Commands have one-second timeouts; the Redis client's offline command queue is disabled. Redis reconnects with a bounded delay; callers must reconnect or retry deliberately. There is no process-local fallback that could create two incompatible versions of a session.

SIGTERM stops new work, sends WebSocket 1012, and gives sockets 500 ms to close before terminating them. SIGKILL has no graceful exchange: clients see abnormal closure and reconnect through the round-robin proxy. Both gateways require the same issuer credential. The proxy retries failed connection attempts to a surviving upstream; it does not automatically replay an ambiguously completed POST.

## Tradeoffs

Polling costs about twenty Redis reads per second per idle attachment and adds up to roughly 50 ms before scheduling/network effects. Each Lua read scans at most the retained stream length. This deliberate ceiling is acceptable for this small experiment. A larger system could use a notification channel to wake readers while keeping the stream as the recovery boundary; that adds notification/subscription race handling which this example avoids.

There is one Redis failure domain, no external account issuer, no per-owner admission control, and no distributed quota. Redis has a 128 MiB limit with `noeviction`; capacity exhaustion is a failed operation, not silent eviction of another session. Docker ports bind to loopback. TLS, private Redis networking/authentication, issuer key rotation and abuse controls belong to a deployment design, not this local demo.
