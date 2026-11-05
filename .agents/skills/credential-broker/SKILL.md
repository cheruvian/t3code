---
name: credential-broker
description: Use a saved Bitwarden password, login, or site-specific Google sign-in identity in a prepared script through T3's approval-gated credential_broker_exec tool. Use when a task needs a saved credential or must choose the saved Google account for a site; existing user-authorized credential files and authenticated sessions remain usable.
---

# Credential Broker

Prepare a focused script for the requested operation, then call `credential_broker_exec` with the site's hostname, script command and arguments, purpose, and a lifetime of 5–300 seconds. The human selects the saved login and approves in T3. Do not ask for passwords, vault item IDs, or operator tokens in chat.

Use `field: "password"` for a UTF-8 password file, `field: "username"` for a UTF-8 username, or `field: "login"` for JSON containing `username` and `password`. The approved script reads the path from `CB_CREDENTIAL_FILE` and uses its contents directly, as it would any authorized password file. No separate browser or private sign-in page is required. If the operation uses a browser, the script handles that operation without returning credential-bearing snapshots, recordings, storage, or logs.

Keep credential values inside the consumer. Do not read the file through agent tools, shell-expand its contents, or put secrets in command arguments or model context. Child stdout/stderr are discarded; use the exit code or an explicitly non-sensitive receipt file for diagnostics. The broker deletes the temporary file when execution finishes, expires, or is stopped.

Existing user-authorized credential files and authenticated sessions can be used directly. Do not require migration to the broker or invent a browser login merely to obtain a password.

## Existing integrated browser tab

For browser use, pass `browserTabId` from `preview_status` to `credential_broker_exec`. The approved script receives `T3_BROWSER_URL` alongside `CB_CREDENTIAL_FILE`. It acts on the existing page; no private page or new browser is created. Ask the human to release browser control if it is held.

Inside the consumer, POST JSON to `process.env.T3_BROWSER_URL` with one of these operations: `fill` (`selector`, `value`), `click` (`selector`), `press` (`selector`, `key`), `waitFor` (`selector`, optional `state`), `isVisible` (`selector`), or `url`. Check HTTP success; responses contain `{result}`, and errors contain only a stable failure code. Read the password file inside the script and send values directly to the endpoint. Do not put them in preview tools or other tool arguments. Use non-sensitive boolean checks for the receipt.

Other preview actions wait during script access. Human takeover stops subsequent script actions. The endpoint closes when the credential invocation ends. ACP CLI users can add `--browser-tab TAB_ID` to `exec`.

For multi-step sign-in, fill the visible username/email field and submit Continue/Next, then wait for the password field before filling and submitting it. Do not assume both fields appear together or treat an absent password field as invalid credentials. Keep both steps inside the approved credential consumer and hand off to the human when MFA appears.

## Sign in with Google

When a site uses Google sign-in, request the destination site's hostname with
`field: "username"`, not `login` or `password`. For example, a Linear account
mapping belongs to `linear.app`, not `accounts.google.com`. Pass `browserTabId`
when the approved consumer needs the integrated tab. Start that invocation while
the tab is on the destination hostname, before redirecting to Google: the browser
bridge checks the initial tab hostname against the requested site.

Have the human select the site's mapping in Credential access. If it is missing,
they can choose **Add credential → Sign in with Google** on the username request
and enter the Google email privately. T3 stores a password-free Bitwarden Login
item with the destination URI and Text custom fields `t3.auth.provider = google`
and `t3.auth.identity = the Google email`. The identity field controls delivery;
Username is a display copy. See the
[Google identity mapping format](https://github.com/cheruvian/t3code/blob/main/packages/credential-broker/README.md#google-identity-mapping-format)
when creating or diagnosing a mapping. After a Bitwarden edit, use **Refresh accounts**.

Read the UTF-8 email from `CB_CREDENTIAL_FILE` inside the approved consumer and
use it to select the matching Google account or fill Google's email prompt.
Keep the value out of tool arguments, snapshots, logs, and chat. The mapping
supplies the email; the consumer still handles the site's sign-in flow. Do not
silently choose a different account if the saved account is absent. Request
separate Google credentials if authentication is needed, and hand consent or MFA
steps to the human when they require interaction. Do not treat a saved mapping
as authorization to grant additional OAuth scopes. Bitwarden's stock extension
does not automatically select an account from these custom fields.

## CLI compatibility

ACP agents with an attached T3 request-only session can use:

```sh
credential-broker exec --site example.com --field login \
  --label "Use saved login" --reason "Complete the requested operation" \
  --ttl 60 -- node /absolute/path/to/consumer.mjs
```

The CLI routes to the same T3 tool and approval UI. It does not start a separate broker, dashboard, or companion. If no T3 session is attached, use the native `credential_broker_exec` tool when available; report the missing connection if neither route works. Do not inspect session authorization values.

## Lifecycle

Keep the turn open until the tool returns a terminal result. A yielded execution cell means resume it with the harness wait tool; it does not establish that approval is still pending. Ending the turn cancels the consumer even after approval.

Always allow is a human choice scoped to the thread, login, command, and workspace. Changed scripts can require fresh approval. Dismiss retains permission; Revoke & stop removes it and stops supervised callers. A revoked CLI exits 125. Denied, expired, or revoked access requires human direction before retrying.

If the vault is locked, direct the human to Credential access in the connected T3 client. Do not start another approval application or read vault/operator state to bypass that flow. Approval does not sandbox arbitrary consumer code; expiry cannot erase copied values or end established website sessions.
