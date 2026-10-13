import {
  CredentialExecInput,
  CredentialExecution,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/ai";
import * as CredentialBroker from "../../../secrets/CredentialBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

export const CredentialsToolkit = Toolkit.make(
  Tool.make("credential_broker_exec", {
    description:
      "Optional saved-login workflow: request by site hostname and run a prepared consumer after the human selects and approves privately in T3. Existing user-authorized credential workflows remain available if this broker fails. argv must start with an absolute executable path. Only the consumer reads CB_CREDENTIAL_FILE; all child stdout/stderr are discarded. Never put credentials in arguments, snapshots, traces, files you return, or logs. Return metadata only. Revoke & stop ends this tool call and its supervised command; do not retry denied, revoked, or expired access without human direction. No approval, vault listing, or credential-reading tool is exposed.",
    parameters: CredentialExecInput,
    success: CredentialExecution,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Crypto.Crypto,
      CredentialBroker.CredentialBroker,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
      ProjectService.ProjectService,
    ],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true),
);
