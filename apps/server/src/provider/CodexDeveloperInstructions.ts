import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly t3CodeProjectDir?: string;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  globalCustomInstructions?: string,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = normalizeAvailability(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({
        harness: "Codex",
        ...runtime,
        customInstructions: globalCustomInstructions,
      }),
    },
    ...(tools.browser
      ? Object.fromEntries(
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.split("\n\n").map((value, index) => [
            `t3_code_tools_${String(index + 1).padStart(2, "0")}`,
            { kind: "application" as const, value },
          ]),
        )
      : {}),
    ...(tools.device
      ? {
          t3_code_tools_device: {
            kind: "application" as const,
            value: T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
          },
        }
      : {}),
  };
}
