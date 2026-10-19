import {
  CredentialBrowserLoginInput,
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
  Tool.make("preview_login", {
    description:
      "Request private sign-in to the integrated T3 browser tab. The site is derived from the actual tab, never a supplied hostname. The human chooses a saved Bitwarden login and approves privately in T3. Credentials go to an unrecorded private page in the same browser profile; this tool returns execution metadata only. Provide CSS selectors for the username, password, and final submit controls. For staged sign-in (such as Google), also provide usernameSubmitSelector for the username step's Next button. The private page submits the username, waits for the visible password field and final submit control, and then submits the password under the same approval. Those password-step controls need not be visible on the initial page. Only same-origin steps are supported; MFA and cross-origin SSO need human sign-in. Do not type or read credentials through preview tools. Keep the turn open until this call finishes; denied, expired or revoked requests need human direction before retrying. Desktop-attached browser tabs are not supported yet. The human may also use the private approval form to enter credentials privately.",
    parameters: CredentialBrowserLoginInput,
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
  Tool.make("credential_broker_exec", {
    description:
      "Optional saved-login workflow: request by site hostname and run a prepared consumer after the human selects and approves privately in T3. Existing user-authorized credential workflows remain available if this broker fails. argv may start with a command name such as uv or an absolute executable path. The broker resolves names using this environment’s PATH before approval, shows the resolved executable, and binds permission and execution to that binary; ttlSeconds must be an integer from 5 to 300. This call waits for both human approval and the consumer to finish. A still-running call or yielded execution cell does not mean approval is pending. Keep the turn open and await the terminal result; send progress in commentary, never a final reply while this call is pending. Ending the turn cancels the request and stops its consumer, including after approval. Only the consumer reads CB_CREDENTIAL_FILE; all child stdout/stderr are discarded. Never put credentials in arguments, snapshots, traces, files you return, or logs. Return metadata only. Revoke & stop ends this tool call and its supervised command; do not retry denied, revoked, or expired access without human direction. No approval, vault listing, or credential-reading tool is exposed.",
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
