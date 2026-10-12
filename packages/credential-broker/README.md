# Credential Broker

The broker owns Bitwarden sessions, private site lookup, temporary credential
delivery, grants, expiry, output suppression, and supervised process groups.
T3 uses its request-only adapter as the primary credential approval experience.
The original CLI and Electron interface remain available as standalone consumers.

## T3

Agents call credential_broker_exec with a site hostname and an absolute executable
plus arguments. T3 supplies the authenticated environment, thread, provider
session, active run, model, workspace, and a server-generated invocation ID.
Caller labels cannot replace this identity. The ID binds the waiting Effect
fiber to its broker request; it is not the provider's native tool-call ID.

Human WebSocket RPCs use access-read/access-write permissions, are classified
ui-only, and are absent from every MCP toolkit and the helper API bridge.
No separate operator bearer token or dashboard is created by the T3 adapter.
Vault choices and grant metadata reach human clients only. Execution results
are explicitly limited to IDs, status, expiry, exit code, and signal.

Always-allow scope includes the authenticated environment, thread, provider
instance, and workspace, along with the selected login, site, fields, exact
command, file variable, script/executable fingerprints, and maximum TTL.
Run/session/invocation IDs do not persist in a grant, so a subsequent run in the
same thread can match. Labels have no authority. Imported dependencies and
arbitrary program behavior are not covered by direct-script fingerprints.

Automatic delivery waits for a visible human presenter to acknowledge its
notice. Its full 300 seconds start then. An unavailable presenter, a full notice
stack, or missing acknowledgment falls back to manual approval. Losing the
presenter stops its active automatic callers unless the notice was dismissed
or expired. Dismiss retains the grant. Revoke removes the grant and stops its
associated active callers; the waiting tool resolves as revoked after cleanup.
T3 turn termination, session revocation, tool interruption, vault lock, and
server shutdown also release associated access.

The adapter uses the same supervisor/watchdog source as the standalone broker.
T3 hosts them through its hidden worker command so Electron and single-executable
runtimes preserve IPC and cleanup. Direct package use embeds those programs. After changing either program, run
node scripts/embed-programs.mjs. The check command detects stale embedded source.

## Standalone compatibility

From this package directory:

    vp run desktop        # human terminal: Bitwarden + optional Electron companion
    vp run desktop:demo   # fake credentials
    node src/cli.js --help

Electron is a development dependency for the optional companion; T3 approval\ndoes not install, load, or launch it.
Never start the standalone operator interface through an agent tool: it prints
a private operator capability URL.

Standalone exec keeps its Unix-socket protocol, private permissions, suppressed
stdout/stderr, supervised cleanup, and revoked exit code 125. File leases remain
standalone only and are unsupervised. CLI labels remain unverified. No standalone
socket request can supply trusted T3 origin metadata.

Inside an ACP session, exec automatically uses its attached request-only T3 MCP
session. --t3 explicitly selects that transport. Native Codex and Claude agents
use credential_broker_exec directly; standalone CLI use remains available outside
T3. The packaged server also supports t3 credential-broker exec. Neither transport
accepts human decisions, exposes vault records, or reads operator tokens.

## Limits and verification

The boundary separates the supported interfaces; it does not isolate arbitrary
same-user shell tools from the filesystem, processes, browser state, or Bitwarden.
Human clients must keep their operator sessions out of agent-controlled browsers.
Approval does not sandbox an arbitrary consumer. The consumer must prevent
credential-bearing snapshots, traces, screenshots, recordings, and application
logs. No suppression system can undo an approved consumer's external side effects.

Revocation deletes active paths and stops supervised process groups. It cannot
erase copies, revoke open descriptors, stop escaped detached processes, rotate
passwords, or invalidate website sessions. Host suspension delays timers until
resume. The watchdog and restart cleanup provide additional recovery.

macOS is verified. Linux needs host verification. Windows fails closed pending
ACL, named-pipe, and process-tree supervision adapters; portable Electron UI does
not supply those guarantees.

    vp run check
    vp run test

Tests use fake credentials. They exercise the real CLI, subprocess supervision,
raw/encoded output suppression, permissions, expiry, cancellation, restart
recovery, private Bitwarden child environments, site filtering, scoped grants,
remote visibility acknowledgment, five-minute notices, dismissal, and revocation.
