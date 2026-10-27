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
      "Use a saved password in a prepared script through a private temporary file. To use the existing integrated browser tab, pass browserTabId from preview_status. The script receives T3_BROWSER_URL and operates that same tab by POSTing JSON: {operation:'fill',selector,value}, {operation:'click',selector}, {operation:'press',selector,key}, {operation:'waitFor',selector,state}, {operation:'isVisible',selector}, or {operation:'url'}. Responses are {result:...}; action failures return {error:'browser_action_failed'}. Never include credential values in tool arguments: the script reads them from CB_CREDENTIAL_FILE and sends them directly to T3_BROWSER_URL. No private page or separate browser is created. Other preview actions wait until this consumer finishes. Request by site hostname; the human selects and approves privately in T3. Set field=password for a UTF-8 password file, field=username for a UTF-8 username, or field=login for JSON containing username and password. The consumer reads the file path from CB_CREDENTIAL_FILE directly; never read that file through agent tools or shell-expand its contents. Use exit codes or an explicitly non-sensitive receipt for operation status. Existing user-authorized credential workflows remain available if this broker fails. argv may start with a command name such as uv or an absolute executable path. The broker resolves names using this environment’s PATH before approval, shows the resolved executable, and binds permission and execution to that binary; ttlSeconds must be an integer from 5 to 300. This call waits for both human approval and the consumer to finish. A still-running call or yielded execution cell does not mean approval is pending. Keep the turn open and await the terminal result; send progress in commentary, never a final reply while this call is pending. Ending the turn cancels the request and stops its consumer, including after approval. Only the consumer reads CB_CREDENTIAL_FILE; all child stdout/stderr are discarded. Never put credentials in arguments, snapshots, traces, files you return, or logs. Return metadata only. Revoke & stop ends this tool call and its supervised command; do not retry denied, revoked, or expired access without human direction. No approval, vault listing, or credential-reading tool is exposed.",
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
