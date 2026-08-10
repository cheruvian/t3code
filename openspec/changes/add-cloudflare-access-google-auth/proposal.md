## Why

A long-lived public Cloudflare Tunnel currently relies on T3's pairing and device-session authentication as its only application gate. Users should be able to add an independent Google identity check at Cloudflare's edge for one configured tunnel hostname without weakening T3 authentication or manually reproducing an error-prone Access policy.

## What Changes

- Add a guided Cloudflare Access section to the desktop Connections settings for a configured user-managed Cloudflare Tunnel hostname.
- Connect to a Cloudflare account with a least-privilege API token kept in desktop secret storage, and list existing Google identity providers without collecting or storing Google OAuth client secrets.
- Create and reconcile a self-hosted Access application for the exact hostname, restricted to one selected Google identity provider and an explicit allowlist of email addresses or email domains.
- Report whether protection is configured, externally managed, drifted, unreachable, or failing, and verify that an unauthenticated request encounters Cloudflare Access before reporting protection as active.
- Let the user remove only the Access resources created by T3. Tunnel connectivity and T3's own pairing/session authentication remain independent and continue to work behind Access.
- Document Cloudflare/Google prerequisites, least-privilege API-token creation, recovery, revocation, and manual setup as a fallback.

## Capabilities

### New Capabilities

- `cloudflare-access-protection`: Configure, observe, reconcile, verify, and remove hostname-specific Cloudflare Access protection backed by an existing Google identity provider.

### Modified Capabilities

None.

## Impact

- Desktop Connections UI and its Cloudflare Tunnel settings presentation.
- Typed contracts, desktop preload/IPC, secure credential persistence, and a desktop-side Cloudflare API adapter.
- Cloudflare Zero Trust Access applications, policies, and identity-provider discovery for the selected account and hostname.
- Focused tests for credential handling, ownership/conflicts, idempotent reconciliation, policy safety, status verification, teardown, and UI state.
- User documentation for Cloudflare Access and Google identity-provider setup.
