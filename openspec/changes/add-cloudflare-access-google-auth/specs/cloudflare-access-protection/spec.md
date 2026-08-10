## Purpose

Provide a safe, observable way to place a Google identity check in front of one user-managed Cloudflare Tunnel hostname while retaining T3's own pairing and session authorization behind it.

## ADDED Requirements

### Requirement: Desktop-only Access management
The system SHALL expose Cloudflare Access management in desktop Connections settings and SHALL keep tunnel process management independent from Access management.

#### Scenario: Access management is available for a named tunnel
- **WHEN** the desktop environment has a user-managed Cloudflare Tunnel configuration
- **THEN** Connections offers a Cloudflare Access setup for an explicitly entered public hostname

#### Scenario: Access setup fails
- **WHEN** Access configuration cannot be completed
- **THEN** the local tunnel and T3's pairing/session authentication remain unchanged

### Requirement: Existing Google identity provider
The system SHALL discover Google identity providers already configured in the selected Cloudflare Zero Trust account and SHALL NOT collect, create, return, or persist Google OAuth client secrets.

#### Scenario: Google provider is available
- **WHEN** valid Cloudflare account credentials can read identity providers and at least one provider has the Google type
- **THEN** the user can select exactly one Google provider for the protected hostname

#### Scenario: Google provider is absent
- **WHEN** the selected account has no Google identity provider
- **THEN** the system explains that the provider must first be configured and tested in Cloudflare and does not create an Access application

### Requirement: Protected Cloudflare API credential
The system SHALL accept only an account identifier and least-privilege Cloudflare API token needed to inspect identity providers and manage Access applications and policies. The token MUST be encrypted with desktop operating-system-backed storage at rest and MUST NOT be returned to the renderer after submission or included in settings, logs, diagnostics, errors, or exported state.

#### Scenario: Protected storage is available
- **WHEN** the user submits a valid account identifier and API token and desktop encryption is available
- **THEN** the system verifies the required Cloudflare permissions, stores the token encrypted, and returns only redacted connection metadata

#### Scenario: Protected storage is unavailable
- **WHEN** operating-system-backed encryption is unavailable
- **THEN** the system refuses persistent Cloudflare API setup and does not write the token to disk

#### Scenario: Credential becomes invalid
- **WHEN** Cloudflare rejects a previously stored token
- **THEN** the system reports that reconnection is required without exposing the token and leaves existing edge protection unchanged

### Requirement: Explicit hostname and allowlist
The system SHALL require a normalized HTTPS hostname, one selected Google identity provider, and at least one explicit allowed email address or email domain before provisioning protection. It SHALL NOT create an allow-anyone, bypass, or wildcard-host policy.

#### Scenario: Valid personal allowlist
- **WHEN** the user submits an exact hostname, a Google provider, and one or more valid email addresses
- **THEN** the resulting Allow policy admits only matching Google-authenticated identities

#### Scenario: Valid domain allowlist
- **WHEN** the user submits an exact hostname, a Google provider, and one or more normalized email domains
- **THEN** the resulting Allow policy admits only Google-authenticated identities in those domains

#### Scenario: Unsafe policy input
- **WHEN** the hostname is wildcarded or the allowlist is empty, malformed, or equivalent to allowing everyone
- **THEN** provisioning is rejected before any Cloudflare mutation occurs

### Requirement: Google-only self-hosted application
The system SHALL create a self-hosted Cloudflare Access application for only the configured hostname, set its allowed identity providers to the selected Google provider, and skip the provider chooser by redirecting directly to that provider.

#### Scenario: First provisioning succeeds
- **WHEN** the hostname is unclaimed and all prerequisites are valid
- **THEN** one hostname-specific Access application and its explicit Allow policy are created and recorded as T3-managed resources

#### Scenario: Another Access application owns the hostname
- **WHEN** Cloudflare already has an Access application for the exact hostname and it is not recorded as T3-managed
- **THEN** the system reports an externally managed conflict and does not modify or delete that application or its policies

### Requirement: Idempotent ownership-aware reconciliation
The system SHALL reconcile only the Access application and policy identifiers created by this T3 environment. Repeating an unchanged request MUST NOT create duplicate applications or policies, and detected drift MUST be reported before destructive replacement.

#### Scenario: Unchanged reconciliation
- **WHEN** the stored managed resource identifiers and desired configuration already match Cloudflare
- **THEN** reconciliation performs no mutation and reports the protection as configured

#### Scenario: Managed policy input changes
- **WHEN** the user changes the selected Google provider or allowlist for resources still owned by T3
- **THEN** the system updates the managed application and policy without creating a duplicate hostname owner

#### Scenario: Managed resource has incompatible drift
- **WHEN** a recorded resource exists but its hostname, type, or ownership relationship no longer matches the saved metadata
- **THEN** the system reports drift and requires explicit recovery instead of overwriting the resource

### Requirement: Edge protection verification
The system SHALL distinguish Cloudflare resource configuration from effective edge enforcement. It SHALL use an unauthenticated, credential-free request to the public hostname and report protection as active only when the response is recognized as a Cloudflare Access authentication challenge.

#### Scenario: Access challenge is observed
- **WHEN** the Cloudflare resources match the desired configuration and an unauthenticated probe receives a recognized Access challenge
- **THEN** Connections reports Google protection as active

#### Scenario: Resources exist but origin remains public
- **WHEN** Cloudflare resources exist but the unauthenticated probe reaches T3 without an Access challenge
- **THEN** Connections reports protection as ineffective and does not claim that Google authentication is active

#### Scenario: Hostname cannot be probed
- **WHEN** DNS, tunnel connectivity, or the public hostname is unavailable
- **THEN** Connections reports configuration separately from unverifiable edge status

### Requirement: Safe removal and disconnection
The system SHALL provide explicit removal of T3-managed Access protection and separate disconnection of the stored Cloudflare API credential. It MUST NOT remove externally managed resources or disable the Cloudflare Tunnel.

#### Scenario: Remove managed protection
- **WHEN** the user confirms removal and the recorded resources still match T3 ownership metadata
- **THEN** the system removes the managed Access application and policy references while leaving the tunnel and T3 authentication enabled

#### Scenario: Removal cannot verify ownership
- **WHEN** ownership cannot be confirmed or Cloudflare is unreachable
- **THEN** the system preserves the remote resources and reports manual recovery steps

#### Scenario: Disconnect Cloudflare account
- **WHEN** the user disconnects the account credential
- **THEN** the encrypted API token is removed locally while existing Cloudflare Access resources remain in place

### Requirement: Client compatibility disclosure
The system SHALL explain that the first release supports interactive Google Access through direct browser navigation to the protected hostname and SHALL warn before provisioning that hosted cross-origin, mobile, and native remote clients may not complete the Cloudflare Access browser-cookie flow.

#### Scenario: User reviews compatibility warning
- **WHEN** the user begins Access provisioning
- **THEN** the confirmation identifies direct browser access as supported and does not represent every T3 client as compatible

### Requirement: Operational documentation
The system SHALL document Google identity-provider setup in Cloudflare, minimum API-token permissions, exact-host policy behavior, verification, client compatibility, credential revocation, resource recovery, and a manual-dashboard fallback.

#### Scenario: User chooses manual setup
- **WHEN** the user does not want to provide T3 a Cloudflare API token
- **THEN** the documentation provides a dashboard-based procedure that achieves the same Google-only exact-host protection
