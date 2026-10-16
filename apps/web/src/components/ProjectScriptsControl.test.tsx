// @vitest-environment jsdom
import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, type ProjectScript } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("~/state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

import ProjectScriptsControl, { importableProjectFileScripts } from "./ProjectScriptsControl";
import { TooltipProvider } from "./ui/tooltip";

it("runs an inherited primary action without requiring a project-owned copy", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const action: ProjectScript = {
    id: "file:dev",
    name: "Dev",
    command: "pnpm dev",
    icon: "play",
    runOnWorktreeCreate: false,
  };
  const run = vi.fn();
  const unusedMutation = async () => AsyncResult.success(undefined);
  try {
    await act(async () => {
      root.render(
        <RegistryProvider>
          <TooltipProvider>
            <ProjectScriptsControl
              environmentId={EnvironmentId.make("inherited-script-test")}
              scripts={[action]}
              editableScriptIds={new Set()}
              inheritedScriptIds={new Set([action.id])}
              onRunScript={run}
              onAddScript={unusedMutation}
              onUpdateScript={unusedMutation}
              onDeleteScript={unusedMutation}
            />
          </TooltipProvider>
        </RegistryProvider>,
      );
    });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Run Dev"]');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    await act(async () => button!.click());
    expect(run).toHaveBeenCalledExactlyOnceWith(action);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("does not offer an inherited action as another import with a different command", () => {
  expect(
    importableProjectFileScripts(
      [{ name: "DEV", command: "other command" }],
      [
        {
          id: "global:dev",
          name: "Dev",
          command: "pnpm dev",
          icon: "play",
          runOnWorktreeCreate: false,
        },
      ],
    ),
  ).toEqual([]);
});
