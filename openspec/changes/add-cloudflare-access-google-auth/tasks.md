## 1. Contracts and Persistence

- [ ] 1.1 Add behavior-first contract tests for Cloudflare Access connection input, redacted account metadata, Google provider summaries, desired policy input, managed-resource identity, configuration status, and enforcement status.
- [ ] 1.2 Implement the shared schemas and desktop bridge methods without exposing a stored API token in any readable state or response.
- [ ] 1.3 Add migration/default tests for optional Cloudflare Access metadata in desktop settings, including normalized hostname, allow entries, selected provider, and managed application/policy IDs.
- [ ] 1.4 Implement non-secret metadata persistence and a dedicated encrypted API-token store using Electron safe storage, with tests for unavailable encryption, replacement, deletion, corruption, and redacted failures.

## 2. Cloudflare API Boundary

- [ ] 2.1 Add fixture-backed tests for token/account verification, Google identity-provider discovery, Access application operations, policy operations, pagination, timeouts, Cloudflare error envelopes, and secret redaction.
- [ ] 2.2 Implement the narrow desktop Cloudflare Access HTTP adapter with bounded requests and no authorization-header or response-body logging.
- [ ] 2.3 Add permission and provider classification tests that distinguish missing/invalid credentials, insufficient Access permissions, no Google provider, and transient Cloudflare failures.

## 3. Desired Policy and Reconciliation

- [ ] 3.1 Add pure validation tests for exact-host normalization, explicit email/domain allowlists, Google-only provider selection, and rejection of wildcard, empty, malformed, Any, Bypass, or Service Auth configurations.
- [ ] 3.2 Implement the desired self-hosted application and Allow-policy projection with one allowed Google IdP and direct identity redirect.
- [ ] 3.3 Add reconciliation tests for unclaimed creation, same-host external conflicts, unchanged no-op, compatible updates, missing resources, incompatible drift, and duplicate prevention.
- [ ] 3.4 Implement ownership-by-recorded-UUID reconciliation, persisting managed IDs safely and refusing to adopt or overwrite external resources.
- [ ] 3.5 Add failure tests for every partial-create boundary, including successful compensation and surfaced manual cleanup when compensation fails.
- [ ] 3.6 Implement staged creation and best-effort rollback without changing tunnel state or T3 authentication on failure.

## 4. Verification and Removal

- [ ] 4.1 Add edge-probe tests for recognized Cloudflare Access challenges, publicly reachable T3 responses, redirects unrelated to Access, DNS/network failure, and credential-free request construction.
- [ ] 4.2 Implement explicit refresh with separate configuration and enforcement status; avoid continuous Cloudflare API or public-host polling.
- [ ] 4.3 Add removal tests for verified managed ownership, ambiguous drift, unreachable Cloudflare, externally managed resources, and local credential disconnection.
- [ ] 4.4 Implement confirmed managed-resource removal and independent local API-token disconnection, leaving the tunnel and T3 sessions untouched.

## 5. Desktop Integration

- [ ] 5.1 Wire the Cloudflare Access service into desktop layers, typed IPC channels, preload, and lifecycle using focused handler tests.
- [ ] 5.2 Add Connections presentation-logic tests for disconnected, missing-provider, ready-to-provision, active, ineffective, unreachable, conflict, drifted, and failed states.
- [ ] 5.3 Build the desktop Connections setup flow for account connection, Google provider selection, exact hostname, explicit allowlist, confirmation, refresh, reconcile, remove, and disconnect actions.
- [ ] 5.4 Add the pre-provisioning compatibility warning for direct-browser support and the current hosted web, mobile, and native remote-client limitations.
- [ ] 5.5 Verify that credential values never enter renderer-readable state, toast text, diagnostics, settings search, browser storage, screenshots, or test artifacts.

## 6. Documentation and Verification

- [ ] 6.1 Extend the Cloudflare Tunnel user guide with Google IdP prerequisites, least-privilege API-token permissions, automated setup, manual-dashboard fallback, verification states, compatibility, revocation, rollback, and recovery.
- [ ] 6.2 Run focused contract, desktop settings/secret-store, API adapter, reconciliation, IPC, and Connections tests plus scoped contracts/desktop/web typechecks, targeted lint, and config validation.
- [ ] 6.3 Perform an integrated desktop pass using an isolated T3 state and mocked Cloudflare API for every UI state, capturing before/after evidence for the Connections change.
- [ ] 6.4 With explicit maintainer credentials and a disposable hostname only, verify create, Google redirect, authenticated T3 pairing, policy update, removal, and credential revocation without recording secrets; otherwise document this production-boundary check as pending.
