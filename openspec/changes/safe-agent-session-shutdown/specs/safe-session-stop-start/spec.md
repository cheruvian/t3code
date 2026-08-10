## Purpose

Defines safe server stop and restart behavior that drains agent work when possible and guarantees durable client-visible session status converges after graceful shutdowns, crashes, and provider replacement.

## ADDED Requirements

### Requirement: Intentional stop drains active turns

The system SHALL enter a client-visible draining state before an intentional stop or restart, reject new turn starts while draining, and wait for active turns to leave `starting` or `running` before stopping provider runtimes, unless the user explicitly forces the stop or the drain policy expires.

#### Scenario: Active turn completes during drain

- **WHEN** an intentional restart is requested while one or more turns are active
- **THEN** the system prevents new turns, reports the active drain count to clients, waits for every active turn to reach a durable terminal state, and only then stops provider runtimes and restarts

#### Scenario: Tool call completes without completing the turn

- **WHEN** an active turn returns a tool result while the server is draining but the turn has not completed
- **THEN** the system continues draining and does not treat the tool-call boundary as safe to stop

#### Scenario: User cancels draining

- **WHEN** a user with shutdown authority cancels an in-progress drain before provider shutdown begins
- **THEN** the system returns to normal admission and does not stop or restart

#### Scenario: User forces restart

- **WHEN** a user with shutdown authority chooses to restart immediately during a drain
- **THEN** the system durably interrupts active work before stopping providers and clearly reports that work was interrupted

#### Scenario: Interactive drain expires

- **WHEN** an update or restart requested by a connected interactive client reaches its drain deadline before active work completes
- **THEN** the system remains running and draining, reports that user action is required, and waits for an authorized cancel or force choice rather than choosing either automatically

#### Scenario: Interactive requester disconnects after expiry

- **WHEN** an interactive drain has expired and its initiating client disconnects
- **THEN** the authoritative drain remains visible to other authorized clients and does not force or cancel solely because the requester disconnected

#### Scenario: Process signal drain expires

- **WHEN** an operating-system or launcher stop signal cannot complete an ordinary drain within its bounded shutdown budget
- **THEN** the system durably interrupts remaining active work, drains lifecycle ingestion and projection, and proceeds with provider and process shutdown

### Requirement: Drain state is visible on every client

The system SHALL expose authoritative server drain state to web, desktop, and mobile clients, including the requested action, remaining active-work count, and whether cancellation or force-stop is available.

#### Scenario: Connected clients observe drain

- **WHEN** any client initiates an intentional stop or restart
- **THEN** every connected client displays a prominent persistent shutdown warning and disables or rejects new-turn submission

#### Scenario: Client connects during drain

- **WHEN** a client connects after draining has begun
- **THEN** its initial server lifecycle state includes the active drain and it displays the warning before allowing conflicting work

### Requirement: Graceful shutdown durably terminates session lifecycle

Graceful provider shutdown SHALL produce or await orchestration events that move every durable `starting` or `running` session to a terminal lifecycle state before shutdown completion; changing only coarse provider runtime state is insufficient.

#### Scenario: Graceful shutdown with active work

- **WHEN** a provider session is durably `running` at graceful shutdown and the turn cannot complete normally
- **THEN** orchestration records the session as `interrupted`, clears its active turn, settles the client-visible turn as interrupted before the provider runtime is marked stopped, and preserves that final status after the adapter exit event is ingested

#### Scenario: Graceful shutdown without active work

- **WHEN** a provider shell has no active turn at graceful shutdown
- **THEN** orchestration records the session as `stopped` without falsely marking completed work interrupted

#### Scenario: Repeated terminal transition

- **WHEN** shutdown processing repeats for a session already in the required terminal state
- **THEN** the resulting durable state is unchanged and no contradictory lifecycle transition is produced

### Requirement: Startup reconciles orphaned durable work before readiness

On every startup, the system SHALL reconcile durable session shells in `starting` or `running` against current-generation provider ownership before publishing a client-ready lifecycle event, serving an initial thread snapshot, or accepting new work.

#### Scenario: Durable running shell with stopped runtime

- **WHEN** startup finds a durable `running` session whose provider runtime binding is `stopped`
- **THEN** it emits an idempotent orchestration transition to `interrupted` when an active turn exists, or `stopped` otherwise, and waits for projection completion before readiness

#### Scenario: Crash leaves runtime claiming running

- **WHEN** startup finds a durable `starting` or `running` session whose runtime binding claims `running` but is owned by a prior server generation
- **THEN** the binding is treated as orphaned and the durable lifecycle is reconciled through orchestration events

#### Scenario: Runtime binding is absent

- **WHEN** startup finds a durable `starting` or `running` session with no matching current-generation runtime binding
- **THEN** the session is treated as orphaned and reconciled through orchestration events

#### Scenario: Multiple reconciliation passes

- **WHEN** startup reconciliation or recovery runs more than once over the same persisted state
- **THEN** every pass converges to the same event-derived shell and turn state without duplicate side effects or regression to an active status

#### Scenario: Initial snapshot is not misleading

- **WHEN** a client connects during replacement startup after stale durable work exists
- **THEN** it cannot receive a ready server snapshot that reports the orphaned work as Working

### Requirement: Provider lifecycle events are generation fenced

Every newly started provider session SHALL have a durable opaque generation identity, and generation installation, lifecycle-event validation, and durable lifecycle mutation SHALL be authoritatively serialized per thread so an event can mutate orchestration state only while its generation remains current.

#### Scenario: Late exit from an old session

- **WHEN** an exit or state event from an older provider session arrives after a newer generation is bound to the thread
- **THEN** the event is ignored for durable lifecycle mutation and cannot stop, interrupt, or overwrite the newer session

#### Scenario: Replacement commits after old event validation begins

- **WHEN** an old-generation event begins validation, a replacement generation commits before the event's durable lifecycle mutation, and the old event then resumes
- **THEN** the authoritative per-thread precondition rejects the old event and it produces no lifecycle mutation for the replacement session

#### Scenario: Current generation event

- **WHEN** a lifecycle event carries the currently bound provider session generation
- **THEN** normal lifecycle ingestion and durable orchestration projection proceed

#### Scenario: Shutdown-owned interruption receives current-generation exit

- **WHEN** forced or signal-driven shutdown has durably marked active work `interrupted` and the stopped adapter subsequently emits a matching-generation exit
- **THEN** exit ingestion preserves the shutdown-owned `interrupted` session and turn while still allowing an idle `ready` session to converge to `stopped`

#### Scenario: Migrated binding without generation

- **WHEN** startup encounters pre-change persisted state without generation metadata
- **THEN** it treats active-looking ownership as unverifiable and reconciles it as orphaned rather than allowing it to overwrite a newly generated session

### Requirement: Reconciliation preserves legitimate idle states

The system SHALL distinguish durable work lifecycle from coarse provider runtime state and SHALL NOT infer staleness from valid idle combinations.

#### Scenario: Ready shell with running provider runtime

- **WHEN** a durable session is `ready` and its provider runtime is `running`
- **THEN** reconciliation preserves the `ready` shell because the provider is alive and idle

#### Scenario: Ready shell with stopped provider runtime

- **WHEN** a durable session is `ready` and its provider runtime is `stopped` after idle reaping
- **THEN** reconciliation does not classify the shell as stale Working state or mark completed work interrupted

#### Scenario: Running shell with stopped runtime

- **WHEN** a durable session remains `running` while its matching runtime is durably `stopped`
- **THEN** reconciliation converges the session and active turn away from Working

### Requirement: Recovery is event-derived and replay-equivalent

All client-visible lifecycle repair SHALL flow through orchestration commands and events, and live projection and bootstrap replay SHALL produce equivalent session and turn state.

#### Scenario: Live reconciliation and replay

- **WHEN** reconciliation events are applied once to a live projection and separately replayed from the event store into an empty projection
- **THEN** both projections contain equivalent terminal session status, cleared active-turn linkage, and settled turn state

#### Scenario: Reconciliation completion ordering

- **WHEN** reconciliation dispatches lifecycle repair commands
- **THEN** startup waits on typed command receipts and relevant worker drains before advertising readiness, without sleep-based polling

### Requirement: Interrupted work is not automatically re-executed

After restart, the system SHALL preserve resumable provider conversation identity where supported but SHALL NOT automatically submit a synthetic continuation for a turn that was interrupted by stop or crash.

#### Scenario: Restart after interrupted tool-capable turn

- **WHEN** startup reconciles an interrupted turn that may already have performed external side effects
- **THEN** the client shows the turn as interrupted and requires an explicit user action before any continuation is sent

### Requirement: Turn-aborted ingestion remains independent

This capability SHALL NOT change the ingestion semantics of provider `turn.aborted` events.

#### Scenario: Implementing safe stop and reconciliation

- **WHEN** this change is implemented
- **THEN** fixes or refactors specific to `turn.aborted` ingestion are excluded from its code and tests
