import * as Schema from "effect/Schema";

import { ORCHESTRATION_WS_METHODS } from "./orchestration.ts";
import { WS_METHODS } from "./rpc.ts";

export type AgentApiExposure = "agent" | "ui-only" | "internal";
export type AgentApiMutability = "read" | "write" | "destructive";

export interface AgentApiOperation {
  readonly name: string;
  readonly surface: "rpc" | "orchestration";
  readonly exposure: AgentApiExposure;
  readonly mutability: AgentApiMutability;
  readonly scope?: "configuration";
}

const readOnlyNamePatterns = [
  /(^|\.)(get|list|search|read|probe|status|discover|refreshStatus|subscribe)/,
  /\.review\.get/,
];
const destructiveNamePatterns = [
  /remove/,
  /delete/,
  /revert/,
  /signalProcess/,
  /installRelayClient/,
];
const agentNamePatterns = [
  /^server\.(getConfig|getSettings|updateSettings|upsertKeybinding|removeKeybinding)$/,
  /^projects\.(listEntries|readFile|searchContents|searchEntries|writeFile)$/,
  /^orchestration\.(dispatchCommand|getTurnDiff|getFullThreadDiff|searchThreads|subscribeShell|subscribeThread)$/,
];

function classifyOperation(name: string): Pick<AgentApiOperation, "exposure" | "mutability"> {
  const exposure: AgentApiExposure = agentNamePatterns.some((pattern) => pattern.test(name))
    ? "agent"
    : "ui-only";
  const mutability: AgentApiMutability = destructiveNamePatterns.some((pattern) =>
    pattern.test(name),
  )
    ? "destructive"
    : readOnlyNamePatterns.some((pattern) => pattern.test(name))
      ? "read"
      : "write";
  return { exposure, mutability };
}

const operationNames = [
  ...Object.values(WS_METHODS).map((name) => ({ name, surface: "rpc" as const })),
  ...Object.values(ORCHESTRATION_WS_METHODS).map((name) => ({
    name,
    surface: "orchestration" as const,
  })),
];

/** Contract-derived inventory consumed by the T3 Code metaproject. */
export const AGENT_API_INVENTORY: ReadonlyArray<AgentApiOperation> = operationNames.map(
  ({ name, surface }) => ({
    name,
    surface,
    ...classifyOperation(name),
    ...(/^server\.(getSettings|updateSettings|upsertKeybinding|removeKeybinding)$/.test(name)
      ? { scope: "configuration" as const }
      : {}),
  }),
);

/** Names of the operations the agent-facing MCP bridge must serve. */
export const AGENT_EXPOSED_API_NAMES: ReadonlyArray<string> = AGENT_API_INVENTORY.filter(
  (operation) => operation.exposure === "agent",
).map((operation) => operation.name);

export function agentApiInventoryJson(): string {
  return `${JSON.stringify({ version: 2, operations: AGENT_API_INVENTORY }, null, 2)}\n`;
}

/** Failure surface of the agent-facing `api_call` MCP tool. */
export class AgentApiCallError extends Schema.TaggedErrorClass<AgentApiCallError>()(
  "AgentApiCallError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["unknown_operation", "unavailable", "invalid_input", "failed"]),
    message: Schema.String,
  },
) {}
