import * as Effect from "effect/Effect";
import * as CredentialBroker from "../../../secrets/CredentialBroker.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { CredentialsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(CredentialsToolkit, {
  credential_broker_exec: McpToolAccess.actsAsCaller((input) =>
    CredentialBroker.CredentialBroker.pipe(
      Effect.flatMap((broker) => broker.executeFromTool(input)),
      Effect.mapError(unavailable),
    ),
  ),
});
