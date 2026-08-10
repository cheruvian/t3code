## Context

See `proposal.md` for motivation and `specs/cloudflare-access-protection/spec.md` for the behavior contract. T3 currently manages a local `cloudflared` child from the desktop process but deliberately treats the user's YAML, DNS, Cloudflare account, and Access policies as external. Cloudflare Access adds a second, independent control plane: the desktop must make authenticated Cloudflare API calls, while the protected application continues to use T3's existing pairing and scoped sessions after edge authentication.

Cloudflare recommends configuring identity providers in the Zero Trust dashboard. Its Access API supports account-scoped identity-provider discovery and self-hosted application/policy management. A self-hosted application can allow exactly one provider and redirect directly to it. Google configuration requires OAuth material owned by the user and Cloudflare, so T3 must not become a custodian for those Google secrets.

## Goals / Non-Goals

**Goals:**

- Keep Cloudflare mutations in a desktop-only, typed boundary with explicit ownership and reversible operations.
- Store the Cloudflare API token only through Electron's operating-system-backed safe storage.
- Make provisioning idempotent, fail closed on unsafe policy input, and distinguish configured resources from effective edge enforcement.
- Preserve T3 authentication as the inner authorization layer and preserve tunnel availability when Access management fails.

**Non-Goals:**

- Creating or storing Google OAuth clients, client secrets, Workspace configuration, or Cloudflare Zero Trust organizations.
- Managing tunnel YAML, DNS routes, certificates, or the `cloudflared` process as part of Access reconciliation.
- Adopting, rewriting, or deleting pre-existing Access applications and policies.
- Claiming native mobile, remote desktop, or hosted cross-origin compatibility before those clients implement an interactive Cloudflare Access session flow.
- General-purpose Cloudflare account or Access policy management.

## Decisions

### 1. Reuse an existing Google provider

The setup flow lists account identity providers and accepts only a selected provider whose Cloudflare type is Google. If none exists, the UI links to the dashboard setup/test instructions.

This avoids handling Google client credentials and follows Cloudflare's recommended IdP setup path. Creating the Google provider through T3 was rejected because it expands secret custody, consent-screen setup, callback configuration, and recovery far beyond hostname protection.

### 2. Store Cloudflare credentials separately from ordinary settings

Persist non-secret metadata in desktop settings: account identifier, normalized hostname, selected IdP identifier/name, allow entries, managed application/policy identifiers, and last observed status. Persist the API token in a dedicated encrypted desktop credential document backed by `ElectronSafeStorage`; the renderer can submit or replace a token but can only read `connected: true/false` plus redacted metadata.

If safe storage encryption is unavailable, persistent setup fails with the platform remediation already used by desktop credentials. Plaintext fallback and environment-variable persistence were rejected because they would silently weaken the promised boundary.

### 3. Use a dedicated desktop Cloudflare Access adapter

Add a small adapter around the official HTTPS API surface needed by this feature:

- inspect token/account access and list identity providers;
- list/get/create/update/delete self-hosted Access applications;
- get/create/update/delete the policy attached to the managed application.

The adapter accepts the token only at call time, applies bounded request timeouts, maps Cloudflare envelopes into typed redacted failures, and never logs request authorization headers or response bodies that may contain sensitive account data. The desktop service owns validation, reconciliation, and status; the renderer remains a presentation client over typed preload/IPC methods.

Using `cloudflared` CLI commands was rejected because the CLI is designed for tunnel lifecycle rather than complete Access policy management and would make structured ownership/error handling fragile. Adding a broad Cloudflare SDK is unnecessary unless implementation proves the narrow fetch adapter unmaintainable.

### 4. Require an explicit hostname instead of parsing YAML

The Access section asks for an exact public hostname and normalizes it to lowercase ASCII without scheme, path, query, fragment, credentials, port, or wildcard. It does not parse or rewrite the user-owned tunnel YAML. The UI can display the configured tunnel path nearby, but matching the hostname to YAML remains a user-visible prerequisite verified by the edge probe.

Parsing YAML was rejected because cloudflared supports richer ingress structures and includes; partial parsing would create false confidence and violate the existing authoritative-config boundary.

### 5. Provision one app and one least-privilege policy

The desired resource is a self-hosted application for the exact hostname with `allowed_idps` containing only the selected Google provider, `auto_redirect_to_identity` enabled, and App Launcher visibility disabled. Its Allow policy contains only normalized explicit-email and email-domain Include rules. Empty lists, wildcard hosts, an Any selector, Bypass, and Service Auth are outside the accepted model.

Creation is staged: validate and perform conflict reads first, create the application, then its policy; if policy creation fails, attempt best-effort deletion of the newly created application and report any cleanup failure. Saved remote IDs become the ownership boundary. A same-host application not matching saved IDs is external and blocks provisioning.

### 6. Reconcile by recorded identity, not names

Resource names are human-readable but not ownership proof. Subsequent reads and writes use saved application and policy UUIDs, then verify account, type, hostname, and containment before mutation. An unchanged desired projection is a no-op. Compatible changes update in place. Missing resources become `drifted`; incompatible resources require explicit recovery and are never automatically replaced.

Automatic adoption and name-prefix ownership were rejected because either could overwrite administrator-managed security policy.

### 7. Model configuration and enforcement separately

The state contract exposes two axes:

- configuration: disconnected, prerequisites-missing, unconfigured, configured, conflict, drifted, or failed;
- enforcement: unknown, access-challenge-observed, origin-public, or unreachable.

After reconciliation and on explicit refresh, the desktop makes a credential-free request with redirects disabled and no T3 or Cloudflare cookies. A recognized Cloudflare Access login redirect/challenge marks enforcement active. A normal T3 response marks it ineffective. Network failure remains unknown/unreachable rather than being presented as secure or insecure without evidence. Polling is slow and user-triggerable; it does not continuously call Cloudflare APIs or the public endpoint.

### 8. Keep provisioning explicit and removal conservative

Unlike local save-on-blur settings, provisioning and removal are explicit confirmed actions because they mutate an external security control plane. Disconnecting the API credential is separate and local-only; it never tears down Access. Removing protection verifies stored ownership, deletes only the managed application/policy, and leaves the tunnel and T3 sessions untouched.

### 9. Scope the first client surface honestly

Direct navigation to the protected hostname lets a browser complete Google's redirect and retain the Cloudflare Access cookie before loading T3. Hosted `app.t3.codes`, native mobile, and remote desktop clients do not currently have a shared way to complete and attach that cookie to HTTP and WebSocket traffic. The first release warns about this limitation instead of silently breaking those clients. A future capability can add a shared interactive Access-session adapter.

## Risks / Trade-offs

- **[API drift]** Cloudflare API shapes or permission names can change → isolate them behind a narrow adapter, validate response envelopes, use fixture-backed contract tests, and keep current permission guidance in user docs.
- **[Partial provisioning]** Application creation can succeed before policy creation fails → stage reads first, compensate newly created resources, persist IDs as soon as safely known, and surface manual cleanup instructions when compensation fails.
- **[False security signal]** API configuration can exist while DNS or request routing bypasses Access → require an independent unauthenticated edge challenge before showing active protection.
- **[Credential compromise]** A Cloudflare API token can mutate Access resources → require account-scoped least privilege, encrypt at rest, redact all boundaries, support local disconnection, and document Cloudflare-side revocation.
- **[External administrator changes]** Cloudflare dashboard edits can invalidate saved assumptions → detect drift by UUID and immutable relationship checks; never overwrite ambiguous resources.
- **[Client lockout]** Access browser cookies are not supported by every T3 client → show the compatibility warning before provisioning and preserve documented manual rollback.
- **[Access outage]** Google or Cloudflare authentication can make the hostname unavailable → keep local/Tailnet access and T3 auth independent; removal remains possible through the desktop API credential or Cloudflare dashboard.

## Migration Plan

1. Add optional metadata defaults and encrypted-credential storage; existing users remain unconfigured and behavior does not change.
2. Ship read-only credential verification and provider discovery before enabling provisioning controls.
3. Enable create/reconcile/remove with ownership checks and edge verification.
4. Add user documentation and compatibility warnings before presenting the feature as generally available.
5. Rollback by hiding provisioning UI and leaving existing Cloudflare resources untouched; users can retain or remove them from the Cloudflare dashboard. Removing the local encrypted token is always safe and does not alter edge policy.
