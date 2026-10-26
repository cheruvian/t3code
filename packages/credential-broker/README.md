# Credential Broker

The broker owns Bitwarden sessions, private site lookup, temporary credential
delivery, grants, expiry, output suppression, and supervised process groups.
T3 uses its request-only adapter as the primary credential approval experience.
The CLI forwards requests from attached ACP sessions to the same T3 approval flow.

## T3

Agents call credential_broker_exec with a site hostname and a command name such
as `uv` or an absolute executable path, plus arguments. The broker resolves names
using the server's PATH, ignoring empty and relative PATH entries. It resolves
symlinks before approval and uses that exact path for approval, grant scope, and
execution; no shell aliases or functions are evaluated. T3 supplies the authenticated environment, thread, provider
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

The broker supervises consumer processes and credential-file expiry.
T3 hosts them through its hidden worker command so Electron and single-executable
runtimes preserve IPC and cleanup. Direct package use embeds those programs. After changing either program, run
node scripts/embed-programs.mjs. The check command detects stale embedded source.

## CLI compatibility

Agents with an attached T3 request-only provider session can run:

    credential-broker exec --site example.com --field password --reason "Run the requested operation" -- node /absolute/path/to/consumer.mjs

The CLI forwards command names to the environment for resolution and uses T3's
connected web, desktop, or mobile client for approval. Native agents call
`credential_broker_exec` directly. The packaged server also supports
`t3 credential-broker exec`. These transports return execution metadata only;
they cannot approve requests, expose vault choices, or start an approval interface.

## Limits and verification

The broker does not isolate arbitrary same-user shell tools from the filesystem, processes, browser state, or Bitwarden.
Human clients must keep their operator sessions out of agent-controlled browsers.
Approval does not sandbox an arbitrary consumer. The consumer must prevent
credential-bearing snapshots, traces, screenshots, recordings, and application
logs. No suppression system can undo an approved consumer's external side effects.

Revocation deletes active paths and stops supervised process groups. It cannot
erase copies, revoke open descriptors, stop escaped detached processes, rotate
passwords, or invalidate website sessions. Host suspension delays timers until
resume. The watchdog and restart cleanup provide additional recovery.

macOS is verified. Linux needs host verification. Windows fails closed pending
ACL, named-pipe, and process-tree supervision adapters.

    vp run check
    vp run test

Tests use fake credentials. They exercise the T3 CLI transport, subprocess supervision,
raw/encoded output suppression, permissions, expiry, cancellation, restart
recovery, private Bitwarden child environments, site filtering, scoped grants,
remote visibility acknowledgment, five-minute notices, dismissal, and revocation.
