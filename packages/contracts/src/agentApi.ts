import { ORCHESTRATION_WS_METHODS } from "./orchestration.ts";
import { WS_METHODS } from "./rpc.ts";

export type AgentApiExposure = "agent" | "ui-only" | "internal";
export type AgentApiMutability = "read" | "write" | "destructive";

export interface AgentApiOperation {
  readonly name: string;
  readonly surface: "rpc" | "orchestration";
  readonly exposure: AgentApiExposure;
  readonly mutability: AgentApiMutability;
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
  /^(projects\.(list|add|remove)|server\.(getConfig|getSettings|updateSettings|upsertKeybinding|removeKeybinding))$/,
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
  ({ name, surface }) => ({ name, surface, ...classifyOperation(name) }),
);

export function agentApiInventoryJson(): string {
  return `${JSON.stringify({ version: 1, operations: AGENT_API_INVENTORY }, null, 2)}\n`;
}
