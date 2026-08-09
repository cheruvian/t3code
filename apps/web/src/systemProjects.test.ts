import { expect, it } from "vite-plus/test";
import { hasThreadForProject, isT3CodeSystemProject } from "./systemProjects";

const project = {
  environmentId: "env" as never,
  id: "project",
  workspaceRoot: "/runtime/t3code",
  projectKey: "env:project",
  displayName: "T3 Code",
  groupedProjectCount: 1,
  environmentPresence: "local-only" as const,
  allRemoteMembersAreDesktopLocal: false,
  memberProjects: [
    {
      environmentId: "env" as never,
      id: "project",
      workspaceRoot: "/runtime/t3code",
      physicalProjectKey: "env:project",
      environmentLabel: null,
    },
  ],
  memberProjectRefs: [{ environmentId: "env" as never, projectId: "project" }],
  remoteEnvironmentLabels: [],
} as const;

it("identifies the environment's generated T3 Code workspace", () => {
  expect(
    isT3CodeSystemProject(
      project as never,
      new Map([["env" as never, { environment: { t3CodeProjectRoot: "/runtime/t3code" } }]]),
    ),
  ).toBe(true);
});

it("keeps a system project out of the sidebar until it has a thread", () => {
  expect(hasThreadForProject(project as never, [])).toBe(false);
  expect(
    hasThreadForProject(project as never, [
      { environmentId: "env" as never, projectId: "project" },
    ]),
  ).toBe(true);
});
