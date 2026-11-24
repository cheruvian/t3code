import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, type ProjectScript } from "@t3tools/contracts";
import { act, render } from "../../test/render";
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

import ProjectScriptsControl, {
  importableProjectFileScripts,
  type ProjectScriptActionResult,
} from "./ProjectScriptsControl";
import { TooltipProvider } from "./ui/tooltip";

it("runs an inherited primary action without requiring a project-owned copy", async () => {
  const action: ProjectScript = {
    id: "file:dev",
    name: "Dev",
    command: "pnpm dev",
    icon: "play",
    runOnWorktreeCreate: false,
  };
  const run = vi.fn();
  const unusedMutation = async () => AsyncResult.success(undefined);
  await using screen = await render(
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
  const button = screen.container.querySelector<HTMLButtonElement>('button[aria-label="Run Dev"]');
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(false);
  await act(async () => button!.click());
  expect(run).toHaveBeenCalledExactlyOnceWith(action);
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

import * as Cause from "effect/Cause";
import { page, userEvent } from "vite-plus/test/browser";

it.each(["edit", "dismiss", "newer import fails first"] as const)(
  "keeps a failed import from replacing a newer action after %s",
  async (nextAction) => {
    const older = Promise.withResolvers<ProjectScriptActionResult>();
    const newer = Promise.withResolvers<ProjectScriptActionResult>();
    await using screen = await render(
      <ProjectScriptsControl
        environmentId={EnvironmentId.make("test")}
        displayMode="panel"
        scripts={[
          {
            id: "local-check",
            name: "Local check",
            command: "echo local",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ]}
        fileScripts={[
          { name: "Shared build", command: "echo build" },
          { name: "Shared lint", command: "echo lint" },
        ]}
        onRunScript={() => {}}
        onAddScript={({ name }) => (name === "Shared build" ? older.promise : newer.promise)}
        onUpdateScript={async () => AsyncResult.success(undefined)}
        onDeleteScript={async () => AsyncResult.success(undefined)}
      />,
    );

    const actions = screen.getByRole("button", { name: "Script actions" });
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    const failure = AsyncResult.failure<void, unknown>(
      Cause.fail(new Error("Settings write failed")),
    );

    await actions.click();
    await page.getByRole("menuitem", { name: /Shared build/ }).click();
    await actions.click();

    switch (nextAction) {
      case "edit":
        await page.getByRole("button", { name: "Edit Local check" }).click();
        await act(async () => older.resolve(failure));
        expect(name.query()).toHaveProperty("value", "Local check");
        break;
      case "dismiss":
        await page.getByRole("menuitem", { name: "Add project script" }).click();
        await expect.element(dialog).toBeVisible();
        await userEvent.keyboard("{Escape}");
        await expect.element(dialog).not.toBeInTheDocument();
        await act(async () => older.resolve(failure));
        expect(dialog.query() === null).toBe(true);
        break;
      case "newer import fails first":
        await page.getByRole("menuitem", { name: /Shared lint/ }).click();
        await act(async () => newer.resolve(failure));
        await act(async () => older.resolve(failure));
        expect(name.query()).toHaveProperty("value", "Shared lint");
        break;
    }
  },
);
