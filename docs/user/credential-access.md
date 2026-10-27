# Saved login access

Credential Broker lets an agent use a saved Bitwarden login without putting its
username or password in chat. Install and sign in to the Bitwarden CLI on the
machine running your T3 server. Open **Credential access** in T3 and unlock the
vault privately. If needed, expand **Bitwarden CLI location** to choose its
executable.

An agent requests a site hostname and a prepared program. T3 shows the verified
thread, agent, workspace, program, arguments, fields, and access lifetime. Purpose
and labels come from the caller. Choose the matching login, then deny access,
allow it once, or always allow its exact scope.

For a thread agent to use a saved password, ask it to prepare a script for the
operation and run it with `credential_broker_exec`. Choose the saved login in the
private approval dialog. The script receives a temporary file path through
`CB_CREDENTIAL_FILE`: `field: "password"` delivers the password as UTF-8 text;
`field: "login"` delivers JSON with `username` and `password`.

The script reads the file directly and uses the value internally. The agent does
not need to read it or open a browser. The tool returns execution status and an
exit code; script output is discarded. The temporary file is deleted when the
program finishes, expires, or is stopped. An existing private credential file can
also be used directly by a script when you authorize it.

For an operation in the integrated browser, ask the agent to use the existing
tab with `credential_broker_exec`. The approved script receives both the credential
file and access to that tab. It fills and submits the visible page without opening
a private page or another browser. Release browser control before the script runs;
taking control interrupts its next browser action.

To add a login, choose **Enter and save a new login** in the request dialog.
Enter the requested site's username and password, then choose
**Save to Bitwarden & allow once**. This creates a new login for the site and
shares it with the waiting program once. It doesn't replace existing logins or
grant ongoing access. If lookup finds no matching login or fails, the dialog
stays open so you can enter one. Unlock the vault before saving, and keep the
site password separate from your Bitwarden master password.

Always allow is limited to that thread, provider, workspace, login, site, fields,
command, executable and direct-script fingerprints, and maximum lifetime.
Changed commands require another approval. Every automatic use shows a notice
for five minutes after it appears, including after the program finishes.
Dismiss retains permission. **Revoke & stop** removes permission, deletes active
credential files, stops supervised programs, and ends their waiting credential
tool calls. Saved permissions remain available to revoke under Credential access.

Approval works in the connected T3 web, desktop, or mobile client. Operator
access requires the environment's access-read and access-write permissions;
a standard agent MCP credential cannot approve requests or see vault choices.
Use an authenticated, encrypted remote connection for vault unlock. Agents never
need an operator token. If no connected human client can visibly show an automatic
use notice, access requires manual approval.

Credentials go directly to the approved consumer through a private temporary
file. Child output is discarded. Approval is not a sandbox: approve only programs
you trust, and do not use browser snapshots, tracing, recordings, or logs while
the consumer handles credentials. File expiry and revocation cannot erase copies,
revoke open descriptors, undo completed operations, or end website sessions.

The broker is verified on macOS. Linux uses the POSIX boundary but needs platform
verification. Windows fails closed until ACL, named-pipe, and process-tree
security adapters are implemented and verified.
