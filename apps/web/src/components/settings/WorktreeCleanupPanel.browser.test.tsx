import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ReactNode } from "react";
import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({ threads: [] as EnvironmentThreadShell[] }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ id: "project", environmentId: "env", title: "Fixture" }],
  useThreadShells: () => state.threads,
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [], isLoading: false, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: vi.fn(), removeSettledWorktrees: {} },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { isRepo: true, hasWorkingTreeChanges: false, workingTree: { files: [] } },
    isPending: false,
    error: null,
  }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    connectedEnvironments: [{ environmentId: "env", label: "Fixture machine" }],
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));

import { WorktreeCleanupPanel } from "./WorktreeCleanupPanel";

it.each(["finished", "pending question", "fork", "unrelated"] as const)(
  "reports cleanup ownership for a %s child",
  async (scenario) => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const parent = makeThreadFixture({
      id: ThreadId.make("parent"),
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project"),
      worktreePath: "/fixture/worktrees/feature",
      settledAt: "2026-10-15T12:00:00.000Z",
      runtime: null,
    });
    state.threads = [
      makeThreadFixture({
        ...parent,
        id: ThreadId.make("child"),
        settledAt: null,
        hasPendingUserInput: scenario === "pending question",
        lineage: {
          rootThreadId: parent.id,
          parentThreadId: scenario === "unrelated" ? ThreadId.make("other-parent") : parent.id,
          relationshipToParent: scenario === "fork" ? "fork" : "subagent",
        },
      }),
      parent,
    ];
    try {
      await using screen = await render(<WorktreeCleanupPanel />, { router: false });
      const container = screen.container;
      if (scenario === "finished") {
        expect(container.textContent).toContain("Settled · remote status checked when removing");
        expect(container.textContent).not.toContain("Shared by 2 conversations · kept");
      } else {
        expect(container.textContent).toContain("Shared by 2 conversations · kept");
        expect(container.textContent).not.toContain(
          "Settled · remote status checked when removing",
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
