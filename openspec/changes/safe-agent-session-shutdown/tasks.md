## 1. Lifecycle Contracts and Persistence

- [x] 1.1 Add shared opaque owner-generation and provider-session-generation schemas, additive provider runtime binding fields, and a migration that preserves legacy rows without manufacturing ownership.
- [x] 1.2 Add the typed server drain snapshot, lifecycle stream additions, control inputs, and server-draining turn-admission error contracts with compatibility decoding for older clients.
- [x] 1.3 Persist a fresh server owner generation before provider hydration and add repository operations that atomically read, compare, and update generation-owned runtime bindings.
- [x] 1.4 Thread a fresh provider-session generation through session start, every provider adapter runtime-event envelope, persisted bindings, and session replacement paths.

## 2. Generation Fencing and Reconciliation Core

- [x] 2.1 Add a keyed Provider Lifecycle Coordinator that serializes generation installation and lifecycle-event validation through the typed durable orchestration receipt, accepting legacy untagged events only while no generated replacement binding exists.
- [x] 2.2 Add a Session Reconciler that queries durable `starting`/`running` shells, classifies missing, stopped, legacy, and prior-owner bindings as orphaned, and preserves all `ready` shells.
- [x] 2.3 Dispatch deterministic orchestration lifecycle commands under the per-thread lifecycle lease, selecting `interrupted` for shells with active turns and `stopped` otherwise, and persist a generation-scoped shutdown interruption disposition.
- [x] 2.4 Make reconciliation await typed command receipts and relevant ingestion/projection worker drains, then verify convergence without sleeps or direct projection-table writes.
- [x] 2.5 Place startup reconciliation behind the activation barrier before ready lifecycle publication, initial client snapshots, provider session reaping, or new turn admission.

## 3. Graceful Drain and Shutdown Ordering

- [x] 3.1 Implement the Drain Coordinator state machine and persisted snapshot for begin, progress, cancel, commit, and force transitions.
- [x] 3.2 Gate new turn starts and provider-session replacements while draining while continuing to admit steering, approval, and user-input responses needed by existing turns.
- [x] 3.3 Derive outstanding drain work from durable session shells and wait for turn/session terminal transitions rather than tool-call completion.
- [x] 3.4 Route graceful and forced shutdown through the Session Reconciler, await lifecycle projection, then stop adapters and mark coarse runtime bindings stopped while preventing matching-generation exit from downgrading a shutdown-owned interruption.
- [x] 3.5 Integrate desktop update, server self-update, launcher/process-signal, and ordinary server teardown with the entry-point expiry matrix: interactive expiry remains action-required across requester disconnect; non-interactive bounded expiry durably force-interrupts.
- [x] 3.6 Preserve provider resume cursors for later explicit work but do not auto-submit a continuation for interrupted turns after restart.

## 4. Client Surfaces

- [x] 4.1 Add shared client-runtime drain state handling and reject or disable new-turn submission consistently for local, remote/relay, and tunnel connections.
- [x] 4.2 Add a prominent persistent web/desktop shutdown banner showing action, active-work count, blocked work, cancel, and force-restart controls.
- [x] 4.3 Add the equivalent mobile shutdown banner and controls using the shared lifecycle contract.
- [x] 4.4 Ensure a client connecting mid-drain renders the warning from its initial lifecycle snapshot before exposing conflicting actions.
- [x] 4.5 Update user documentation for safe restart, blocked turns, forced interruption, and explicit post-restart continuation behavior.

## 5. Focused Server Verification

- [x] 5.1 Add a graceful-shutdown test proving a running session and active turn durably become and remain `interrupted` after matching-generation adapter exit ingestion and runtime stop complete; prove idle ready shutdown becomes `stopped`.
- [x] 5.2 Add startup tests for durable running shells paired with stopped, missing, legacy, and prior-owner runtime bindings, including crash-style rows that still claim running.
- [x] 5.3 Add repeated-reconciliation tests proving multiple passes are idempotent and replay-safe with no contradictory lifecycle events.
- [x] 5.4 Add provider replacement tests proving late exit/state events cannot overwrite a new session, including the interleaving where old-event validation begins before replacement commits and durable dispatch resumes afterward; prove current-generation events still ingest.
- [x] 5.5 Add preservation tests for valid shell `ready` plus runtime `running` and shell `ready` plus runtime `stopped` combinations.
- [ ] 5.6 Add live-projection versus bootstrap/replay equivalence tests for reconciled session status, cleared active-turn linkage, and settled interrupted turn state.
- [x] 5.7 Add activation-order tests proving clients cannot receive a ready initial snapshot or start work while stale active shells remain unreconciled.
- [ ] 5.8 Add drain tests for normal completion, intermediate tool completion, pending approval/input, cancellation, force, interactive expiry, requester disconnect, signal-driven automatic force, and typed server-draining admission errors.

## 6. Client Verification and Scope Audit

- [x] 6.1 Add shared client-runtime tests for initial and streaming drain snapshots, reconnect during restart, action gating, and recovery to ready.
- [ ] 6.2 Add focused web/desktop and mobile component tests for the prominent warning, active and blocked counts, cancel/force controls, and disabled submission.
- [x] 6.3 Run targeted contract, persistence, orchestration, provider, client-runtime, web, desktop, and mobile tests touched by the change; use receipts and worker drains rather than timing sleeps.
- [x] 6.4 Audit shutdown/restart entry points, all provider adapters, all three clients, local/remote/tunnel modes, reverse actions, and user docs; record intentional non-applicability decisions.
- [x] 6.5 Confirm the diff contains no `turn.aborted` ingestion fix, unrelated projector restructuring, direct projection repair, or access to live T3 userdata.
