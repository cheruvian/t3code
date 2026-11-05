import { makeThreadPullRequests } from "@t3tools/source-control-core/shared/threadPullRequests";

import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

export { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export const {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  resolveThreadPullRequestChains,
  threadPullRequestsOf,
} = makeThreadPullRequests(sourceControlDefinitions);
