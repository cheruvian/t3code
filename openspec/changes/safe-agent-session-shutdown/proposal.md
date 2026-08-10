## Why

Restarting or shutting down T3 Code can interrupt active agent work and leave the durable, client-visible session lifecycle stuck at `running` after the provider process has stopped. Safe stop/start needs one coordinated contract that drains active turns when possible and guarantees that persisted orchestration state converges after graceful shutdown, crashes, and replacement startup.

## What Changes

- Add a server-wide drain lifecycle for intentional shutdown and restart that blocks new turn admission, allows active turns to reach a safe terminal boundary, and supports cancel or explicit force-stop behavior.
- Expose durable drain progress to all connected clients and show a prominent warning while shutdown is pending.
- Make graceful provider shutdown dispatch durable orchestration lifecycle transitions rather than updating only coarse provider runtime bindings.
- Reconcile durable `starting` and `running` session shells against provider runtime ownership before the replacement server becomes client-ready or accepts conflicting work.
- Add persisted server/provider generations plus authoritative per-thread lifecycle serialization so orphaned bindings can be detected after hard crashes and late events from an older provider generation cannot race with or overwrite a newer session.
- Keep legitimate idle combinations intact: shell `ready` with runtime `running` or `stopped` is not stale.
- Make stop and reconciliation replay-safe and idempotent, with typed receipts and worker drains for ordering.
- Preserve a shutdown-owned `interrupted` result through subsequent adapter-exit ingestion, while allowing idle session shutdown to converge to `stopped`.
- Define deterministic expiry behavior for interactive, disconnected, and signal-driven drains.
- Treat exact continuation of an interrupted provider turn as unsafe; do not automatically synthesize a continuation that could duplicate tool side effects.
- Keep the separate `turn.aborted` ingestion correction out of scope.

## Capabilities

### New Capabilities

- `safe-session-stop-start`: Server drain behavior, durable shutdown/startup reconciliation, provider-generation fencing, client-visible shutdown state, and recovery semantics for interrupted work.

### Modified Capabilities

None.

## Impact

- Server orchestration commands, events, decider/projector lifecycle handling, provider session directory/runtime persistence, provider adapters, startup activation ordering, and shutdown finalizers.
- Shared wire contracts and client runtime state for drain status and turn-admission errors.
- Web, desktop, and mobile warning surfaces and restart/update entry points.
- Focused server lifecycle, projection/replay, provider generation, and client-state tests.
- No direct writes to projection tables and no changes to live T3 userdata.
