import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const observations = vi.hoisted(() => ({
  listRefs: vi.fn(),
  query: vi.fn(),
  remoteStatus: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: observations.query,
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    listRefs: observations.listRefs,
    remoteStatus: observations.remoteStatus,
    status: observations.status,
  },
}));

import { resolvePassiveRowVcsDemand, usePassiveRowVcsStatus } from "./ThreadStatusIndicators";

const environmentId = EnvironmentId.make("env-1");
const localAtom = Symbol("local-status");

describe("passive row VCS ownership", () => {
  beforeEach(() => {
    observations.listRefs.mockReset();
    observations.query.mockReset();
    observations.remoteStatus.mockReset();
    observations.status.mockReset().mockReturnValue(localAtom);
  });

  it("uses local status only while the row is visible", () => {
    const input = {
      isVisible: true,
      shouldSubscribe: true,
      environmentId,
      cwd: " /repo ",
    };

    expect(resolvePassiveRowVcsDemand(input)).toEqual({
      demand: "local",
      target: { environmentId, input: { cwd: " /repo " } },
    });
    usePassiveRowVcsStatus(input);

    expect(observations.status).toHaveBeenCalledOnce();
    expect(observations.status).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: " /repo " },
    });
    expect(observations.query).toHaveBeenCalledWith(localAtom);
    expect(observations.remoteStatus).not.toHaveBeenCalled();
    expect(observations.listRefs).not.toHaveBeenCalled();
  });

  it.each([
    ["collapsed", false, true, "/repo"],
    ["removed", true, false, "/repo"],
    ["missing cwd", true, true, null],
  ] as const)("releases its query when %s", (_phase, isVisible, shouldSubscribe, cwd) => {
    const input = { isVisible, shouldSubscribe, environmentId, cwd };

    expect(resolvePassiveRowVcsDemand(input)).toBeNull();
    usePassiveRowVcsStatus(input);

    expect(observations.query).toHaveBeenCalledWith(null);
    expect(observations.status).not.toHaveBeenCalled();
    expect(observations.remoteStatus).not.toHaveBeenCalled();
    expect(observations.listRefs).not.toHaveBeenCalled();
  });
});
