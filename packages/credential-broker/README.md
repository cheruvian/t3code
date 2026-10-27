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

## Operator vault search

Connected human clients can send the `search` action with a request ID and a
query of at most 200 characters. A string (including an empty string to browse)
searches saved item names, usernames and hostnames; omitting `query` restores
hostname matches. Results are limited to 100 compatible items and contain only
selection metadata. Queries and results are not returned to the requesting agent.
Search is submitted explicitly rather than run on every keystroke.

Bitwarden's basic CLI search does not index SSH custom fields, so manual search
filters sanitized metadata from `list items` inside the provider. Deleted items
and incompatible types are excluded. Overlapping searches publish only the latest
results; denial or cancellation prevents a late search from reviving a request.

A result with `hostMismatch` can be approved once. Only that human selection
permits delivery without the hostname check; item ID, type and deletion checks
still apply. The request's destination and command are unchanged.

For a mismatched result, the human's always-allow decision saves the requested
host to that item before creating the grant. Login items append a URI; SSH items
append to the `t3-ssh-hosts` Text field. Existing hosts and other fields are
preserved. The Bitwarden edit payload goes through stdin. The response must
confirm the new host, and delivery rechecks it without a mismatch override.
Failed saves leave the request pending with no grant or consumer; cancellation
during a save prevents granting or delivering, even if Bitwarden saved the host.
Searching alone never edits vault entries.

Normal hostname selections still recheck the binding before delivery. All actions
use the existing human-only RPC and permission checks; no search capability is
exposed to agents or the helper API.

## Existing browser tabs

Pass `browserTabId` from `preview_status` to `credential_broker_exec` when the
consumer needs the integrated page. The server binds access to that thread, site,
agent session, and tab for the invocation's lifetime. The consumer receives
`T3_BROWSER_URL` in its environment, never in the tool result or approval metadata.
It sends POST requests with JSON commands to this endpoint:

- `{operation: "fill", selector, value}`
- `{operation: "click", selector}`
- `{operation: "press", selector, key}`
- `{operation: "waitFor", selector, state}` (state defaults to `visible`)
- `{operation: "isVisible", selector}`
- `{operation: "url"}`

Responses contain `{result}`; failed actions return HTTP 400 with
`{error: "browser_action_failed"}`. Raw browser errors are withheld because they
can contain a filled value. Read secrets directly from `CB_CREDENTIAL_FILE` in the
consumer; never interpolate them into a tool call. This bridge uses the existing
page on desktop and server hosts. It creates no browser context or page.
Other preview actions and diagnostic capture wait while the script owns access.
Human takeover prevents subsequent script actions. Cancellation, denial, expiry,
and completion close the endpoint along with the credential invocation.

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

## SSH private key delivery

`field: "sshKey"` delivers the selected Bitwarden SSH item's `sshKey.privateKey`
as a UTF-8 private key file at `CB_CREDENTIAL_FILE`. SSH items (`type: 5`) are
matched by a Text custom field (`type: 0`) named `t3-ssh-hosts`, containing
comma- or whitespace-separated exact hostnames. Search and delivery both check
the binding; sibling domains, deleted items, and login items do not match.
Without operator search support, missing keys return `no_matching_ssh_key`.
T3 keeps the request open for manual vault search instead. Create/import SSH items in Bitwarden;
the broker's inline login creation is unavailable for SSH requests.

An approved consumer can pass the temporary path straight to OpenSSH without
reading the private key or adding it to an agent:

```js
import { spawnSync } from "node:child_process";

const result = spawnSync(
  "ssh",
  [
    "-i",
    process.env.CB_CREDENTIAL_FILE,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "deploy@host.example.com",
    "true",
  ],
  { stdio: "ignore" },
);
process.exitCode = result.status ?? 1;
```

Request `site: "host.example.com"` for this consumer. The host key must already
be trusted, and the destination account must authorize the public key. The
broker does not provision hosts, intercept shell commands, or supply a separate
key passphrase. Use an unencrypted key inside the encrypted Bitwarden vault.
Try existing SSH access first; authentication failures can lead to a key request,
while network errors and host-key mismatches need their own diagnosis. A consumer
may write an explicitly non-sensitive receipt; its stdout and stderr are discarded.
The CLI accepts `--field sshKey` through the same T3 approval path.
