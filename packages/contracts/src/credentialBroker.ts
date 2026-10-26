import { PreviewTabId } from "./preview.ts";
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { EnvironmentId, ThreadId, ProjectId } from "./baseSchemas.ts";

export const CredentialCaller = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  threadTitle: Schema.String,
  projectId: Schema.optional(ProjectId),
  projectName: Schema.optional(Schema.String),
  providerInstanceId: ProviderInstanceId,
  providerSessionId: Schema.String,
  runId: Schema.String,
  toolCallId: Schema.String,
  workspace: Schema.String,
  agent: Schema.String,
});
export type CredentialCaller = typeof CredentialCaller.Type;
export const CredentialExecInput = Schema.Struct({
  site: Schema.String,
  field: Schema.Literals(["login", "username", "password"]),
  label: Schema.String,
  reason: Schema.String,
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 300 })),
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
});
export type CredentialExecInput = typeof CredentialExecInput.Type;

export const CredentialBrowserLoginInput = Schema.Struct({
  tabId: PreviewTabId,
  usernameSelector: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  usernameSubmitSelector: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  ),
  passwordSelector: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  submitSelector: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
export type CredentialBrowserLoginInput = typeof CredentialBrowserLoginInput.Type;

export const CredentialExecutionFailureCode = Schema.Literals([
  "no_matching_login",
  "vault_search_failed",
  "consumer_start_failed",
  "supervisor_start_failed",
  "credential_cleanup_failed",
]);
export const CredentialExecution = Schema.Struct({
  requestId: Schema.String,
  state: Schema.String,
  expiresAt: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  signal: Schema.optional(Schema.NullOr(Schema.String)),
  failureCode: Schema.optional(CredentialExecutionFailureCode),
});
export type CredentialExecution = typeof CredentialExecution.Type;
export const CredentialApproval = Schema.Struct({
  searchPhase: Schema.optional(Schema.Literals(["syncing", "matching"])),
  canSave: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.String),
  requestId: Schema.String,
  state: Schema.String,
  site: Schema.String,
  field: Schema.String,
  label: Schema.String,
  reason: Schema.String,
  clientClaim: Schema.String,
  ttlSeconds: Schema.Number,
  approvalDeadline: Schema.NullOr(Schema.Number),
  expiresAt: Schema.optional(Schema.Number),
  argv: Schema.Array(Schema.String),
  argv0: Schema.optional(Schema.String),
  cwd: Schema.String,
  origin: Schema.optional(CredentialCaller),
  browser: Schema.optional(
    Schema.Struct({ tabId: PreviewTabId, origin: Schema.String, profile: Schema.String }),
  ),
  candidates: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      username: Schema.optional(Schema.String),
      hosts: Schema.Array(Schema.String),
    }),
  ),
  grantId: Schema.optional(Schema.String),
});
export type CredentialApproval = typeof CredentialApproval.Type;
export const CredentialNotice = Schema.Struct({
  noticeId: Schema.String,
  requestId: Schema.String,
  grantId: Schema.String,
  site: Schema.String,
  command: Schema.String,
  expiresAt: Schema.Number,
  revoked: Schema.Boolean,
});
export type CredentialNotice = typeof CredentialNotice.Type;
export const CredentialBrokerState = Schema.Struct({
  status: Schema.Literals(["locked", "unlocking", "ready", "unsupported"]),
  mode: Schema.String,
  error: Schema.optional(Schema.String),
  requests: Schema.Array(CredentialApproval),
  notices: Schema.Array(CredentialNotice),
  grants: Schema.Array(
    Schema.Struct({
      grantId: Schema.String,
      site: Schema.String,
      field: Schema.String,
      argv: Schema.Array(Schema.String),
      argv0: Schema.optional(Schema.String),
      cwd: Schema.String,
      maxTtl: Schema.Number,
      threadId: Schema.optional(Schema.String),
    }),
  ),
});
export type CredentialBrokerState = typeof CredentialBrokerState.Type;
export const CredentialBrokerAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("saveLogin"),
    requestId: Schema.String,
    username: Schema.String.check(Schema.isMaxLength(4096)),
    password: Schema.String.check(Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    type: Schema.Literal("browserManual"),
    requestId: Schema.String,
    username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    type: Schema.Literal("decide"),
    requestId: Schema.String,
    decision: Schema.Literals(["deny", "once", "always"]),
    candidateId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("dismiss"), noticeId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("revoke"), grantId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stop"), requestId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("presenter"),
    viewId: Schema.String,
    visible: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("seen"), viewId: Schema.String, noticeId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("unlock"),
    password: Schema.String,
    executable: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("lock") }),
]);
export type CredentialBrokerAction = typeof CredentialBrokerAction.Type;
export const CredentialBrokerFailureCode = Schema.Literals([
  "vault_locked",
  "vault_unlocking",
  "unsupported_platform",
  "browser_unavailable",
  "invalid_request",
  "consumer_unavailable",
  "caller_cancelled",
  "broker_unavailable",
]);
export class CredentialBrokerError extends Schema.TaggedError<CredentialBrokerError>()(
  "CredentialBrokerError",
  { code: Schema.optional(CredentialBrokerFailureCode) },
) {
  override get message() {
    switch (this.code) {
      case "vault_locked":
        return "Credential Broker vault_locked: open Credential access for this environment and unlock the vault privately in T3.";
      case "vault_unlocking":
        return "Credential Broker vault_unlocking: wait for the human's private vault unlock to finish.";
      case "unsupported_platform":
        return "Credential Broker unsupported_platform: this host's security adapters are unavailable.";
      case "browser_unavailable":
        return "Credential Broker browser_unavailable: private sign-in requires an available agent-controlled HTTP(S) browser tab and its private sign-in page.";
      case "invalid_request":
        return "Credential Broker invalid_request: use a valid hostname, a command name or absolute executable path, an absolute working directory, and an integer lifetime of 5–300 seconds.";
      case "consumer_unavailable":
        return "Credential Broker consumer_unavailable: check that the command is installed on this environment’s PATH (or the supplied absolute path is executable) and the working directory exists. No vault search or approval was started.";
      case "caller_cancelled":
        return "Credential Broker caller_cancelled: the originating tool call or turn ended; no further access is authorized.";
      default:
        return "Credential Broker broker_unavailable: review vault status and access in T3. Provider output is withheld.";
    }
  }
}
