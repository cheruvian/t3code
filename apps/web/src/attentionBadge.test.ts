import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  diffNewlyFinished,
  shouldPlaySessionFinishSound,
  unreadDoneThreadKeys,
} from "./attentionBadge";

const COMPLETED_AT = "2026-08-27T12:00:00.000Z";
const BEFORE_COMPLETION = "2026-08-27T11:59:59.000Z";
const AFTER_COMPLETION = "2026-08-27T12:00:01.000Z";

function thread(
  environment: string,
  id: string,
  completedAt: string | null = COMPLETED_AT,
): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make(environment),
    id: ThreadId.make(id),
    latestTurn: completedAt === null ? null : ({ completedAt } as never),
  } as EnvironmentThreadShell;
}

function key(environment: string, id: string): string {
  return scopedThreadKey(scopeThreadRef(EnvironmentId.make(environment), ThreadId.make(id)));
}

describe("unreadDoneThreadKeys", () => {
  it("includes completed threads whose latest completion has not been visited", () => {
    const result = unreadDoneThreadKeys([thread("env-a", "thread-1")], {
      [key("env-a", "thread-1")]: BEFORE_COMPLETION,
    });

    expect([...result]).toEqual([key("env-a", "thread-1")]);
  });

  it("excludes visited, incomplete, and never-visited threads", () => {
    const shells = [
      thread("env-a", "visited"),
      thread("env-a", "active", null),
      thread("env-a", "never-visited"),
    ];

    expect(
      unreadDoneThreadKeys(shells, {
        [key("env-a", "visited")]: AFTER_COMPLETION,
        [key("env-a", "active")]: BEFORE_COMPLETION,
      }).size,
    ).toBe(0);
  });

  it("keeps equal thread ids distinct across environments", () => {
    const shells = [thread("env-a", "same"), thread("env-b", "same")];
    const result = unreadDoneThreadKeys(shells, {
      [key("env-a", "same")]: BEFORE_COMPLETION,
      [key("env-b", "same")]: BEFORE_COMPLETION,
    });

    expect(result).toEqual(new Set([key("env-a", "same"), key("env-b", "same")]));
  });

  it("returns an empty set for an empty shell collection", () => {
    expect(unreadDoneThreadKeys([], {})).toEqual(new Set());
  });
});

describe("completion rising edges", () => {
  it("returns only keys newly entering the unread Done set", () => {
    expect(diffNewlyFinished(new Set(["existing"]), new Set(["existing", "new"]))).toEqual(["new"]);
  });

  it("plays once for one or several rising edges only when enabled and initialized", () => {
    const previous = new Set(["existing"]);
    const severalFinished = new Set(["existing", "new-a", "new-b"]);

    expect(shouldPlaySessionFinishSound(previous, severalFinished, true, true)).toBe(true);
    expect(shouldPlaySessionFinishSound(previous, severalFinished, false, true)).toBe(false);
    expect(shouldPlaySessionFinishSound(previous, severalFinished, true, false)).toBe(false);
    expect(shouldPlaySessionFinishSound(severalFinished, severalFinished, true, true)).toBe(false);
  });
});
