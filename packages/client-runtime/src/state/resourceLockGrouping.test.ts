import { CommandId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { groupedResourceLocks } from "./resourceLockGrouping.ts";

const localId = EnvironmentId.make("local");
const remoteId = EnvironmentId.make("remote");
const identity = { canonicalKey: "github.com/example/slot-studio", rootPath: "/workspace" };
const script = {
  id: "file:sandbox",
  name: "SANDBOX",
  command: "deploy",
  icon: "play" as const,
  runOnWorktreeCreate: false,
  resource: { color: "#3b82f6", checkoutPrompt: "", releaseCommand: "", releasePrompt: "" },
};
const lock = {
  script,
  threadId: ThreadId.make("remote-thread"),
  operationId: CommandId.make("operation"),
  phase: "held" as const,
};
function project(
  environmentId: EnvironmentId,
  id: string,
  repositoryIdentity: EnvironmentProject["repositoryIdentity"] = identity as EnvironmentProject["repositoryIdentity"],
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: "slot-studio",
    workspaceRoot: `/${environmentId}/${id}`,
    repositoryIdentity,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    defaultModelSelection: null,
  } as EnvironmentProject;
}

describe("grouped resource locks", () => {
  it("reports connected reservations only for the same logical project", () => {
    const local = project(localId, "local");
    const remote = { ...project(remoteId, "remote"), resourceLocks: [lock] };
    const unrelated = {
      ...project(remoteId, "unrelated", {
        canonicalKey: "github.com/example/other",
      } as EnvironmentProject["repositoryIdentity"]),
      resourceLocks: [lock],
    };
    const input = {
      activeProject: local,
      projects: [local, remote, unrelated],
      settings: {
        sidebarProjectGroupingMode: "repository" as const,
        sidebarProjectGroupingOverrides: {},
      },
      primaryEnvironmentId: localId,
    };
    expect(
      groupedResourceLocks({ ...input, connectedEnvironmentIds: new Set([localId, remoteId]) }),
    ).toEqual([{ project: remote, lock }]);
    expect(groupedResourceLocks({ ...input, connectedEnvironmentIds: new Set([localId]) })).toEqual(
      [],
    );
    expect(
      groupedResourceLocks({
        ...input,
        settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
        connectedEnvironmentIds: new Set([localId, remoteId]),
      }),
    ).toEqual([]);
  });
});
