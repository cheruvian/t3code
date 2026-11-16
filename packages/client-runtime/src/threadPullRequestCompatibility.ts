import type {
  ExecutionEnvironmentCapabilities,
  ProjectId,
  ThreadId,
  ThreadPullRequestKey,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import { normalizeThreadPullRequestKey } from "./threadPullRequests.ts";

type LinkingCapabilities = Pick<
  ExecutionEnvironmentCapabilities,
  "threadPullRequests" | "threadPullRequestLinking"
>;

export function threadPullRequestLinkMode(capabilities: LinkingCapabilities | null | undefined) {
  return capabilities?.threadPullRequests === true
    ? "multiple"
    : capabilities?.threadPullRequestLinking === true
      ? "single"
      : "unsupported";
}

/** The server refuses new watches on settled, archived, and subagent threads. */
export function canStartThreadPullRequestWatch(
  thread: Pick<EnvironmentThreadShell, "archivedAt" | "settledAt" | "settledOverride" | "lineage">,
): boolean {
  return (
    thread.archivedAt === null &&
    thread.settledAt === null &&
    thread.settledOverride !== "settled" &&
    thread.lineage.relationshipToParent !== "subagent"
  );
}

export function planThreadPullRequestMutation({
  capabilities,
  threadId,
  reference,
  legacyProjectId = null,
  legacyRepository,
  linked,
}: {
  capabilities: LinkingCapabilities | null | undefined;
  threadId: ThreadId;
  reference: ThreadPullRequestKey & { readonly url: string };
  /** Older servers need the exact repository checkout; same-host routing is not available. */
  legacyProjectId?: ProjectId | null;
  /** Provider selector for legacy APIs, which omit Azure organization and project paths. */
  legacyRepository?: string | undefined;
  linked: boolean;
}) {
  const key = normalizeThreadPullRequestKey(reference);
  switch (threadPullRequestLinkMode(capabilities)) {
    case "multiple":
      return linked
        ? {
            type: "thread.pull-request.link" as const,
            input: { threadId, ...reference, ...key, source: "manual" as const },
          }
        : {
            type: "thread.pull-request.unlink" as const,
            input: {
              threadId,
              ...key,
            },
          };
    case "single":
      if (linked && legacyProjectId === null) return null;
      return {
        type: "thread.meta.update" as const,
        input: {
          threadId,
          linkedPullRequest:
            linked && legacyProjectId !== null
              ? {
                  projectId: legacyProjectId,
                  repository: legacyRepository ?? reference.repository,
                  number: reference.number,
                  url: reference.url,
                }
              : null,
        },
      };
    case "unsupported":
      return null;
  }
}
