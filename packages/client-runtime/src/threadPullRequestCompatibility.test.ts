import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  planThreadPullRequestMutation,
  threadPullRequestLinkMode,
} from "./threadPullRequestCompatibility.ts";

const reference = {
  host: "github.example",
  repository: "team/repo",
  number: 7,
  url: "https://github.example/team/repo/pull/7",
};
const input = {
  threadId: ThreadId.make("thread"),
  reference,
  linked: true,
};
const capabilities = {
  repositoryIdentity: true,
  threadPullRequests: true,
} satisfies ExecutionEnvironmentCapabilities;

describe("thread pull request capability negotiation", () => {
  it.each([true, false])(
    "preserves Forgejo ports in a multi-link mutation: linked=%s",
    (linked) => {
      const mutation = planThreadPullRequestMutation({
        ...input,
        linked,
        capabilities,
        reference: {
          host: "forge.example",
          repository: "team/repo",
          number: 7,
          url: "http://forge.example:3000/team/repo/pulls/7",
        },
      });
      expect(mutation).toMatchObject({ input: { host: "forge.example:3000", number: 7 } });
    },
  );

  it("does not dispatch before the server config loads", () => {
    expect(threadPullRequestLinkMode(undefined)).toBe("unsupported");
    expect(planThreadPullRequestMutation({ ...input, capabilities: undefined })).toBeNull();
  });
  it("plans link and unlink commands", () => {
    expect(planThreadPullRequestMutation({ ...input, capabilities })).toEqual({
      type: "thread.pull-request.link",
      input: { threadId: input.threadId, ...reference, source: "manual" },
    });
    expect(planThreadPullRequestMutation({ ...input, capabilities, linked: false })).toEqual({
      type: "thread.pull-request.unlink",
      input: {
        threadId: input.threadId,
        host: reference.host,
        repository: reference.repository,
        number: reference.number,
      },
    });
  });
});

describe("older-server link routing", () => {
  it("requires an exact checkout for linking and permits unlinking without one", () => {
    const legacy = { threadPullRequestLinking: true };
    expect(threadPullRequestLinkMode(legacy)).toBe("single");
    expect(threadPullRequestLinkMode({})).toBe("unsupported");
    expect(planThreadPullRequestMutation({ ...input, capabilities: legacy })).toBeNull();
    const legacyProjectId = ProjectId.make("checkout");
    expect(
      planThreadPullRequestMutation({ ...input, capabilities: legacy, legacyProjectId }),
    ).toEqual({
      type: "thread.meta.update",
      input: {
        threadId: input.threadId,
        linkedPullRequest: {
          projectId: legacyProjectId,
          repository: reference.repository,
          number: reference.number,
          url: reference.url,
        },
      },
    });
    expect(
      planThreadPullRequestMutation({ ...input, capabilities: legacy, linked: false }),
    ).toEqual({
      type: "thread.meta.update",
      input: { threadId: input.threadId, linkedPullRequest: null },
    });
  });
});
