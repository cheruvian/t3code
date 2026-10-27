import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { planPinnedMove } from "@t3tools/client-runtime/state/thread-sort";
import {
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadOrderAfterMove,
  threadDropLifecycle,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
  type ThreadMoveAvailability,
} from "./threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import { threadJumpTarget } from "../keyboard/threadKeyboardShortcuts";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  isThreadListV2ListItem,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  sortThreadsForListV2,
  threadListV2ListItemsAreEqual,
  threadHasUnseenCompletion,
  type ThreadListV2ListItem,
} from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    ...input,
  });
}

const NOW = "2026-06-02T00:00:00.000Z";

const linkedPullRequest = {
  projectId: ProjectId.make("project-1"),
  repository: "pingdotgg/t3code",
  number: 42,
  url: "https://github.com/pingdotgg/t3code/pull/42",
};

describe("resolveThreadListV2SnoozeMenuSelection", () => {
  it("accepts a displayed evening preset while its wake time is still future", () => {
    const menuOpenedAt = new Date(2026, 4, 8, 16, 59, 30);
    const selectedAt = new Date(2026, 4, 8, 17, 0, 30);
    const displayedPresets = resolveSnoozePresets(menuOpenedAt);

    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:evening",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection).toEqual({
      _tag: "selected",
      preset: displayedPresets.find((preset) => preset.id === "evening"),
    });
  });

  it("expires a displayed preset once its wake time has passed", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 16, 59, 30));

    expect(
      resolveThreadListV2SnoozeMenuSelection({
        event: "snooze:evening",
        displayedPresets,
        now: new Date(2026, 4, 8, 18, 0, 1),
      }),
    ).toEqual({ _tag: "expired" });
  });
});

describe("resolveThreadListV2Status", () => {
  it("distinguishes usage limits from ordinary failures and clears the label after recovery", () => {
    const thread = makeThread({
      id: ThreadId.make("limited"),
      title: "Limited",
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: "Plan limit reached",
        lastErrorClass: "usage_limit",
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("limited");
    expect(
      resolveThreadListV2Status({
        ...thread,
        runtime: { ...thread.runtime!, lastErrorClass: null },
      }),
    ).toBe("failed");
    expect(
      resolveThreadListV2Status({
        ...thread,
        runtime: { ...thread.runtime!, status: "completed" },
      }),
    ).toBe("ready");
  });

  it("prioritizes approval over a running runtime", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      hasPendingApprovals: true,
      runtime: {
        status: "running",
        activeRunId: RunId.make("run-t"),
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("approval");
  });

  it("reports monitoring when presentation parks runtime idle for monitors", () => {
    expect(
      resolveThreadListV2Status(
        makeThread({
          id: ThreadId.make("t"),
          title: "t",
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "Watch build", kind: "monitor" }],
          runtime: {
            status: "idle",
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ),
    ).toBe("monitoring");
  });

  it.each([
    { kind: "command", status: "ready" },
    { kind: "monitor", status: "ready" },
    { kind: "subagent", status: "waiting" },
  ] as const)(
    "presents an unseen completion with a $kind roster as $status",
    ({ kind, status }) => {
      const thread = presentThreadShell(
        environmentId,
        makeRawThreadShell({
          latestRunId: RunId.make("run-background-completion"),
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          lastVisitedAt: DateTime.makeUnsafe("2026-06-01T23:59:00.000Z"),
          pendingBackgroundTasks: [{ taskId: "background-work", kind }],
        }),
      );

      expect(resolveThreadListV2Status(thread)).toBe(status);
      expect(threadHasUnseenCompletion(thread)).toBe(true);
      if (kind === "monitor") {
        expect(resolveThreadListV2Status({ ...thread, lastVisitedAt: NOW })).toBe("monitoring");
      }
    },
  );

  it("resolves ready for quiescent threads", () => {
    expect(resolveThreadListV2Status(makeThread({ id: ThreadId.make("t"), title: "t" }))).toBe(
      "ready",
    );
  });
});

describe("queued messages keep a settled thread active", () => {
  const threads = [
    makeThread({ id: ThreadId.make("active"), title: "Active" }),
    makeThread({ id: ThreadId.make("settled"), title: "Settled", settledOverride: "settled" }),
    makeThread({
      id: ThreadId.make("settled-queued"),
      title: "Settled with outbox",
      settledOverride: "settled",
    }),
  ];
  const queuedThreadKeys = new Set([`${environmentId}:settled-queued`]);

  it("includes it in the reorderable active section", () => {
    expect(
      getThreadListV2OrderedSection({ threads, section: "active", now: NOW, queuedThreadKeys }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["active", "settled-queued"]);
    expect(
      getThreadListV2OrderedSection({ threads, section: "active", now: NOW }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["active"]);
  });
});

describe("resolveThreadListV2SwipeActions", () => {
  it("offers settle and snooze for an active snoozable thread", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: "snooze" });
  });

  it("offers un-settle and snooze for settled history", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "unsettle", secondary: "snooze" });
  });

  it("omits snooze when the server or thread does not allow it", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: null });
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: false,
      }),
    ).toEqual({ primary: "settle", secondary: null });
  });

  it("falls back to archive only for a pre-lifecycle server", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: false,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "archive", secondary: null });
  });

  it("offers wake and no snooze on a snoozed row", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        snoozed: true,
      }),
    ).toEqual({ primary: "unsnooze", secondary: null });
  });
});

describe("resolveThreadListV2SnoozeGateExpiryMs", () => {
  it("reports when an unadopted turn's grace window lapses", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      latestUserMessageAt: "2026-06-02T00:00:30.000Z",
    });
    expect(resolveThreadListV2SnoozeGateExpiryMs(thread, { now: "2026-06-02T00:01:00.000Z" })).toBe(
      Date.parse("2026-06-02T00:02:30.000Z"),
    );
  });

  it("returns null once the thread is snoozable or when only data can unblock it", () => {
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({ id: ThreadId.make("ready"), title: "Ready" }),
        { now: NOW },
      ),
    ).toBe(null);
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({
          id: ThreadId.make("blocked"),
          title: "Blocked",
          hasPendingApprovals: true,
          latestUserMessageAt: NOW,
        }),
        { now: NOW },
      ),
    ).toBe(null);
  });
});

describe("sortThreadsForListV2", () => {
  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForListV2([
      { id: "oldest", createdAt: "2026-06-01T08:00:00.000Z" },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });
});

describe("buildThreadListV2Items", () => {
  it("ignores active positions when disabled but retains pinned positions", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("old"),
        title: "old",
        createdAt: "2026-06-01T08:00:00.000Z",
        activeOrderKey: "f",
      }),
      makeThread({
        id: ThreadId.make("new"),
        title: "new",
        createdAt: "2026-06-01T12:00:00.000Z",
        activeOrderKey: "t",
      }),
      makeThread({
        id: ThreadId.make("pin-new"),
        title: "pin-new",
        createdAt: "2026-06-01T12:00:00.000Z",
        pinnedAt: NOW,
        pinOrderKey: "t",
      }),
      makeThread({
        id: ThreadId.make("pin-old"),
        title: "pin-old",
        createdAt: "2026-06-01T08:00:00.000Z",
        pinnedAt: NOW,
        pinOrderKey: "f",
      }),
    ];
    const input = { threads, environmentId: null, searchQuery: "", now: NOW };
    expect(
      buildThreadListV2Items({ ...input, allowUnpinnedReorder: false }).items.map(
        (item) => item.thread.id,
      ),
    ).toEqual(["pin-old", "pin-new", "new", "old"]);
    expect(
      buildThreadListV2Items({ ...input, allowUnpinnedReorder: true }).items.map(
        (item) => item.thread.id,
      ),
    ).toEqual(["pin-old", "pin-new", "old", "new"]);
  });

  it("places a persisted settled thread in the settled shelf", () => {
    const thread = makeThread({
      id: ThreadId.make("linked-merged"),
      title: "Linked merged pull request",
      linkedPullRequest,
      settledOverride: "settled",
      settledAt: NOW,
    });
    const layout = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.settledCount).toBe(1);
    expect(layout.items[0]?.variant).toBe("slim");
  });

  it("places settled pinned threads in the settled shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-settled"),
          title: "Pinned while settled",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "pinned-settled"]);
    expect(layout.items.map((item) => item.pinned)).toEqual([false, false]);
    expect(layout.settledCount).toBe(1);
  });

  it("keeps active pinned threads in the pinned block", () => {
    const pinned = makeThread({
      id: ThreadId.make("pinned"),
      title: "Pinned thread",
      pinnedAt: "2026-06-01T12:00:00.000Z",
    });
    const layout = buildThreadListV2Items({
      threads: [pinned],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items[0]).toMatchObject({
      thread: { id: "pinned" },
      variant: "card",
      pinned: true,
    });
    expect(layout.settledCount).toBe(0);
  });

  it("classifies snooze with the second-precise clock and reports the next wake", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("just-woke"),
          title: "Just woke",
          snoozedUntil: "2026-06-02T00:00:30.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("still-snoozed"),
          title: "Still snoozed",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: "2026-06-02T00:01:07.500Z",
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["just-woke"]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.nextSnoozeWakeAt).toBe("2026-06-02T09:00:00.000Z");
  });

  it("collapses to a header-only shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items).toEqual([]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.snoozedShelfHeaderIndex).toBe(0);
  });

  it("collapses settled threads to a counted shelf header", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(layout.settledCount).toBe(1);
    expect(layout.settledShelfHeaderIndex).toBe(1);
  });

  it("keeps the selected settled thread visible when its shelf is collapsed", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("selected"),
          title: "Selected",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
      selectedThreadKey: `${environmentId}:selected`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["selected"]);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(0);
  });

  it("keeps cards in creation order while settled sorts by recency", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("older-created"),
          title: "Older",
          createdAt: "2026-06-01T08:00:00.000Z",
          updatedAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("newer-created"),
          title: "Newer",
          createdAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["newer-created", "older-created"]);
  });

  it("sorts settled threads by their persisted settlement timestamp", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("settled-newer"),
          title: "Settled newer",
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
          latestUserMessageAt: "2026-06-01T08:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled-older"),
          title: "Settled older",
          settledOverride: "settled",
          settledAt: "2026-06-01T10:00:00.000Z",
          latestUserMessageAt: "2026-06-01T09:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["settled-newer", "settled-older"]);
  });

  it("includes a thread matched by message content", () => {
    const thread = makeThread({
      id: ThreadId.make("content-match"),
      title: "Unrelated title",
    });
    const { items } = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "relay reconnect",
      matchedThreadKeys: new Set([
        threadSearchMatchKey({
          environmentId,
          threadId: thread.id,
        }),
      ]),
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["content-match"]);
  });

  it("scopes the flat list to one project", () => {
    const projectId = ProjectId.make("project-1");
    const otherProjectId = ProjectId.make("project-2");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("included"), projectId, title: "Included" }),
        makeThread({
          id: ThreadId.make("excluded"),
          projectId: otherProjectId,
          title: "Excluded",
        }),
      ],
      environmentId: null,
      projectRefs: [{ environmentId, projectId }],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["included"]);
  });
});

describe("buildThreadListV2Items settled sort reuse", () => {
  const otherEnvironmentId = EnvironmentId.make("environment-2");

  function makeSettled(
    id: string,
    settledAt: string,
    overrides: Partial<EnvironmentThreadShell> = {},
  ): EnvironmentThreadShell {
    return makeThread({
      id: ThreadId.make(id),
      title: id,
      settledOverride: "settled",
      settledAt,
      ...overrides,
    });
  }

  function settledOrder(
    threads: ReadonlyArray<EnvironmentThreadShell>,
    scope: EnvironmentId | null = null,
  ) {
    return buildThreadListV2Items({
      threads,
      environmentId: scope,
      searchQuery: "",
      now: NOW,
    })
      .items.filter((item) => item.variant === "slim")
      .map((item) => `${item.thread.environmentId}:${item.thread.id}`);
  }

  function countDateParses(build: () => void): number {
    const spy = vi.spyOn(Date, "parse");
    try {
      build();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  const older = makeSettled("older", "2026-06-01T01:00:00.000Z");
  const newer = makeSettled("newer", "2026-06-01T03:00:00.000Z");
  const middle = makeSettled("middle", "2026-06-01T02:00:00.000Z");

  it("orders settled rows newest first regardless of input order", () => {
    expect(settledOrder([older, newer, middle])).toEqual([
      `${environmentId}:newer`,
      `${environmentId}:middle`,
      `${environmentId}:older`,
    ]);
    expect(settledOrder([middle, older, newer])).toEqual([
      `${environmentId}:newer`,
      `${environmentId}:middle`,
      `${environmentId}:older`,
    ]);
  });

  it("re-sorts when the same settled rows arrive in a different order", () => {
    const first = makeSettled("twin", "2026-06-01T01:00:00.000Z");
    const second = makeSettled("twin", "2026-06-01T01:00:00.000Z", {
      environmentId: otherEnvironmentId,
    });
    expect(settledOrder([first, second])).toEqual([
      `${environmentId}:twin`,
      `${otherEnvironmentId}:twin`,
    ]);
    expect(settledOrder([second, first])).toEqual([
      `${otherEnvironmentId}:twin`,
      `${environmentId}:twin`,
    ]);
  });

  it("skips the settled sort when only unsettled rows change", () => {
    const settled = Array.from({ length: 50 }, (_, index) =>
      makeSettled(`settled-${index}`, `2026-06-01T00:${String(index).padStart(2, "0")}:00.000Z`),
    );
    const streaming = makeThread({ id: ThreadId.make("streaming"), title: "Streaming" });
    const baseline = countDateParses(() => settledOrder([streaming, ...settled]));
    const updated = { ...streaming, updatedAt: "2026-06-01T23:00:00.000Z" };
    let order: string[] = [];
    const reused = countDateParses(() => {
      order = settledOrder([updated, ...settled]);
    });

    expect(order).toEqual(settled.toReversed().map((thread) => `${environmentId}:${thread.id}`));
    expect(baseline - reused).toBeGreaterThanOrEqual(settled.length);
  });
});

function makePendingTask(id: string): PendingNewTask {
  const creation = {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree" as const,
    branch: null,
    worktreePath: null,
  };
  return {
    kind: "pending",
    key: `pending-task:${id}`,
    environmentId,
    projectId: creation.projectId,
    projectTitle: undefined,
    projectCwd: undefined,
    branch: null,
    title: id,
    createdAt: NOW,
    message: {
      environmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation,
    },
    creation,
  };
}

describe("buildThreadListV2ListItems", () => {
  const layout = buildThreadListV2Items({
    threads: [
      makeThread({ id: ThreadId.make("active"), title: "active" }),
      makeThread({
        id: ThreadId.make("settled"),
        title: "settled",
        settledOverride: "settled",
        settledAt: NOW,
      }),
    ],
    environmentId: null,
    searchQuery: "",
    now: NOW,
  });

  it("splices queued tasks between the active block and the settled tail", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued-1"), makePendingTask("queued-2")],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(
      items.map((item) =>
        item.type === "v2-pending"
          ? item.pendingTask.title
          : item.type === "v2-thread"
            ? item.item.thread.id
            : item.type === "v2-snoozed-shelf"
              ? "snoozed-shelf"
              : "settled-shelf",
      ),
    ).toEqual(["active", "queued-1", "queued-2", "settled-shelf", "settled"]);
    expect(
      items.filter((item) => item.type === "v2-pending" && item.showPendingDivider),
    ).toHaveLength(1);
  });

  it("ends the list with queued tasks when nothing has settled yet", () => {
    const activeOnly = buildThreadListV2Items({
      threads: [makeThread({ id: ThreadId.make("active"), title: "active" })],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: activeOnly.items,
      pendingTasks: [makePendingTask("queued-1")],
    });

    expect(items.map((item) => item.type)).toEqual(["v2-thread", "v2-pending"]);
  });

  it("keeps the settled shelf between active and settled rows when nothing is queued", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.key)).toEqual([
      `v2-thread:${environmentId}:active`,
      "v2-settled-shelf",
      `v2-thread:${environmentId}:settled`,
    ]);
  });

  it("places queued tasks before a collapsed snoozed shelf", () => {
    const snoozedLayout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: snoozedLayout.items,
      pendingTasks: [makePendingTask("queued")],
      snoozedCount: snoozedLayout.snoozedCount,
      snoozedShelfExpanded: false,
      snoozedShelfHeaderIndex: snoozedLayout.snoozedShelfHeaderIndex,
      settledCount: snoozedLayout.settledCount,
      settledShelfHeaderIndex: snoozedLayout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.type)).toEqual([
      "v2-thread",
      "v2-pending",
      "v2-snoozed-shelf",
      "v2-settled-shelf",
      "v2-thread",
    ]);
    expect(threadJumpTarget(items, "thread.jump.1")?.id).toBe("active");
    expect(threadJumpTarget(items, "thread.jump.2")?.id).toBe("settled");
    expect(threadJumpTarget(items, "thread.jump.3")).toBeNull();
  });
});

describe("pending mobile thread moves", () => {
  function fixture(section: "active" | "pinned" = "active") {
    const rows = ["a", "b", "c"].map((id, index) =>
      makeThread({
        id: ThreadId.make(id),
        title: id === "a" ? "hidden" : "match",
        createdAt: `2026-06-01T0${3 - index}:00:00.000Z`,
        pinnedAt: section === "pinned" ? `2026-06-01T0${3 - index}:00:00.000Z` : null,
      }),
    );
    const ordered = getThreadListV2OrderedSection({ threads: rows, section, now: NOW });
    const orderedIds = ordered.map((row) => `${row.environmentId}:${row.id}`);
    const movedId = orderedIds[2]!;
    const assignments = planPinnedMove({
      orderedIds,
      keysById: new Map(orderedIds.map((id) => [id, null])),
      movedId,
      direction: "up",
    })!;
    const pending = createPendingThreadOrder({
      section,
      ordered,
      movedId,
      direction: "up",
      assignments,
    });
    const update = (current: EnvironmentThreadShell[], assignment: (typeof assignments)[number]) =>
      current.map((row) =>
        `${row.environmentId}:${row.id}` === assignment.id
          ? {
              ...row,
              [section === "pinned" ? "pinOrderKey" : "activeOrderKey"]: assignment.orderKey,
            }
          : row,
      );
    return { rows, assignments, pending, update };
  }

  function layout(
    rows: EnvironmentThreadShell[],
    pendingOrder: PendingThreadOrder | null,
    searchQuery = "",
  ) {
    return buildThreadListV2Items({
      threads: rows,
      pendingOrder,
      environmentId: null,
      searchQuery,
      now: NOW,
    }).items.map((item) => item.thread.id);
  }

  it("keeps search results in the full pending section order", () => {
    const { rows, assignments, pending, update } = fixture();
    const current = update(update(rows, assignments[0]!), assignments[1]!);
    expect(layout(current, pending, "match")).toEqual(["c", "b"]);
  });
});

describe("mobile move availability", () => {
  const oldEnvironment = EnvironmentId.make("older-server");
  function rows(section: "active" | "pinned", keys: readonly (string | null)[]) {
    return keys.map((key, index) =>
      makeThread({
        id: ThreadId.make(`move-${index}`),
        title: `Move ${index}`,
        environmentId: index === 1 ? oldEnvironment : environmentId,
        activeOrderKey: section === "active" ? key : null,
        pinOrderKey: section === "pinned" ? key : null,
        pinnedAt: section === "pinned" ? NOW : null,
      }),
    );
  }

  it("allows an independent keyed move despite an unsupported keyless row elsewhere", () => {
    const ordered = rows("active", [null, null, "bb", "dd", "ff"]);
    const plan = createThreadMovePlanner({
      ordered,
      section: "active",
      reorderableEnvironmentIds: new Set([environmentId]),
    });
    const assignments = plan(`${environmentId}:move-4`, "up");
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe(`${environmentId}:move-4`);
    expect(assignments![0]!.orderKey > "bb").toBe(true);
    expect(assignments![0]!.orderKey < "dd").toBe(true);
  });
});

describe("thread drag destinations", () => {
  it("rejects missing, self, and unchanged destinations", () => {
    for (const targetId of ["missing", "a", "b"]) {
      expect(
        threadOrderAfterMove(["a", "b", "c"], "a", {
          targetId,
          placement: "before",
        }),
      ).toBeNull();
    }
    expect(threadOrderAfterMove(["a", "b"], "missing", "down")).toBeNull();
  });
});

describe("cross-section thread drops", () => {
  it("does not send lifecycle commands for an ordinary Active reorder", () => {
    expect(
      threadDropLifecycle(
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        "active",
        NOW,
      ),
    ).toEqual({ pin: false, unpin: false, unsettle: false, unsnooze: false });
  });
});

const BASE_MS = Date.parse(NOW);
const isoAt = (ms: number) => new Date(ms).toISOString();
const MINUTE_MS = 60_000;

function runningRuntime() {
  return {
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeRunId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function buildTickThreads() {
  return {
    ready: makeThread({
      id: ThreadId.make("tick-ready"),
      title: "tick ready",
      latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
    }),
    approval: makeThread({
      id: ThreadId.make("tick-approval"),
      title: "tick approval",
      hasPendingApprovals: true,
      latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
    }),
    settled: makeThread({
      id: ThreadId.make("tick-settled"),
      title: "tick settled",
      settledOverride: "settled",
      settledAt: isoAt(BASE_MS - 3 * 24 * 60 * MINUTE_MS),
    }),
    snoozed: makeThread({
      id: ThreadId.make("tick-snoozed"),
      title: "tick snoozed",
      snoozedAt: isoAt(BASE_MS - MINUTE_MS),
      snoozedUntil: isoAt(BASE_MS + 2 * 60 * MINUTE_MS),
    }),
  };
}

function buildTickList(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  clockMs: number,
  pendingTasks: ReadonlyArray<PendingNewTask>,
  options?: {
    readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
    readonly queuedThreadKeys?: ReadonlySet<string>;
    readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
    readonly shelfPreferencesLoading?: boolean;
  },
): ThreadListV2ListItem[] {
  const now = isoAt(clockMs);
  const layout = buildThreadListV2Items({
    threads,
    environmentId: null,
    searchQuery: "",
    now,
    snoozedShelfExpanded: true,
  });
  return buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks,
    snoozedCount: layout.snoozedCount,
    snoozedShelfExpanded: true,
    snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
    settledCount: layout.settledCount,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    snoozeLabelNow: now,
    ...(options?.snoozeEnvironmentIds
      ? { snoozeEnvironmentIds: options.snoozeEnvironmentIds }
      : {}),
    ...(options?.queuedThreadKeys ? { queuedThreadKeys: options.queuedThreadKeys } : {}),
    ...(options?.moveAvailability ? { moveAvailability: options.moveAvailability } : {}),
    ...(options?.shelfPreferencesLoading !== undefined
      ? { shelfPreferencesLoading: options.shelfPreferencesLoading }
      : {}),
  });
}

function itemsByThreadKey(items: ReadonlyArray<ThreadListV2ListItem>) {
  const byKey = new Map<string, ThreadListV2ListItem>();
  for (const item of items) byKey.set(item.key, item);
  return byKey;
}

describe("threadListV2ListItemsAreEqual", () => {
  const thread = makeThread({
    id: ThreadId.make("eq"),
    title: "eq",
    latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
  });
  const layout = buildThreadListV2Items({
    threads: [thread],
    environmentId: null,
    searchQuery: "",
    now: NOW,
  });
  const queued = makePendingTask("eq-queued");
  const build = () =>
    buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [queued],
      snoozeLabelNow: NOW,
    });

  it("notices a replaced thread shell", () => {
    const replacement = makeThread({ id: ThreadId.make("eq"), title: "renamed" });
    const rebuilt = buildThreadListV2Items({
      threads: [replacement],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const next = buildThreadListV2ListItems({
      items: rebuilt.items,
      pendingTasks: [],
      snoozeLabelNow: NOW,
    });
    const previousThread = build().find((item) => item.type === "v2-thread")!;
    const nextThread = next.find((item) => item.type === "v2-thread")!;
    expect(threadListV2ListItemsAreEqual(previousThread, nextThread)).toBe(false);
  });

  it("notices shelf count, expansion, and loading-disabled changes", () => {
    const shelf = {
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: 2,
      expanded: true,
      disabled: false,
    } as const;
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf })).toBe(true);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, count: 3 })).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, expanded: false })).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, disabled: true })).toBe(false);
  });

  it("treats different item kinds as unequal", () => {
    const built = build();
    const threadItem = built.find((item) => item.type === "v2-thread")!;
    const pendingItem = built.find((item) => item.type === "v2-pending")!;
    expect(threadListV2ListItemsAreEqual(threadItem, pendingItem)).toBe(false);
  });
});

describe("isThreadListV2ListItem", () => {
  it("narrows the v2 kinds and rejects the legacy discriminators", () => {
    expect(isThreadListV2ListItem({ type: "v2-thread" })).toBe(true);
    expect(isThreadListV2ListItem({ type: "v2-pending" })).toBe(true);
    expect(isThreadListV2ListItem({ type: "v2-snoozed-shelf" })).toBe(true);
    expect(isThreadListV2ListItem({ type: "v2-settled-shelf" })).toBe(true);
    expect(isThreadListV2ListItem({ type: "thread" })).toBe(false);
    expect(isThreadListV2ListItem({ type: "v2-show-more" })).toBe(false);
  });
});

describe("buildThreadListV2ListItems clock scoping", () => {
  const allEnvironments = new Set<EnvironmentId>([environmentId]);
  const tickQueued = () => [makePendingTask("tick-queued")];

  it("carries the snooze menu clock on every row whose swipe menu offers presets", () => {
    const threads = buildTickThreads();
    const items = buildTickList(Object.values(threads), BASE_MS, tickQueued(), {
      snoozeEnvironmentIds: allEnvironments,
    });
    const byKey = itemsByThreadKey(items);
    const ready = byKey.get(`v2-thread:${environmentId}:tick-ready`)!;
    const approval = byKey.get(`v2-thread:${environmentId}:tick-approval`)!;
    const settled = byKey.get(`v2-thread:${environmentId}:tick-settled`)!;
    const snoozed = byKey.get(`v2-thread:${environmentId}:tick-snoozed`)!;
    expect(ready.type === "v2-thread" && ready.snoozePresetMinute).toBe(NOW);
    expect(settled.type === "v2-thread" && settled.snoozePresetMinute).toBe(NOW);
    expect(approval.type === "v2-thread" && approval.snoozePresetMinute).toBeUndefined();
    expect(snoozed.type === "v2-thread" && snoozed.snoozePresetMinute).toBeUndefined();
  });

  it("keeps the snooze menu clock off rows on servers without the capability", () => {
    const threads = buildTickThreads();
    const items = buildTickList([threads.ready], BASE_MS, [], {
      snoozeEnvironmentIds: new Set<EnvironmentId>(),
    });
    const ready = items.find((item) => item.type === "v2-thread")!;
    expect(ready.type === "v2-thread" && ready.snoozePresetMinute).toBeUndefined();
  });

  it("blanks the precomputed time for rows that render a label instead", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const working = makeThread({
        id: ThreadId.make("tick-working"),
        title: "tick working",
        latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
        runtime: runningRuntime(),
      });
      const threads = buildTickThreads();
      const items = buildTickList(
        [threads.ready, working, threads.settled, threads.snoozed],
        BASE_MS,
        tickQueued(),
      );
      const byKey = itemsByThreadKey(items);
      const label = (key: string) => {
        const item = byKey.get(key)!;
        return item.type === "v2-thread" ? item.timeLabel : "<shelf>";
      };
      expect(label(`v2-thread:${environmentId}:tick-ready`)).toBe("5m");
      expect(label(`v2-thread:${environmentId}:tick-working`)).toBe("");
      expect(label(`v2-thread:${environmentId}:tick-settled`)).toBe("3d");
      expect(label(`v2-thread:${environmentId}:tick-snoozed`)).toBe("");
      const snoozed = byKey.get(`v2-thread:${environmentId}:tick-snoozed`)!;
      expect(snoozed.type === "v2-thread" && snoozed.snoozeWakeLabelText).toBe("2h");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("thread list v2 minute tick invalidation", () => {
  it("only invalidates rows whose clock-driven content moved", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const threads = buildTickThreads();
      const shellOrder = [threads.ready, threads.approval, threads.settled, threads.snoozed];
      const pendingTasks = [makePendingTask("tick-queued")];
      const atStart = buildTickList(shellOrder, BASE_MS, pendingTasks);
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList(shellOrder, BASE_MS + MINUTE_MS, pendingTasks);

      expect(atStart.length).toBe(atNextMinute.length);
      const invalidated: string[] = [];
      for (let index = 0; index < atStart.length; index += 1) {
        if (!threadListV2ListItemsAreEqual(atStart[index]!, atNextMinute[index]!)) {
          invalidated.push(atStart[index]!.key);
        }
      }
      expect(invalidated).toEqual([
        `v2-thread:${environmentId}:tick-ready`,
        `v2-thread:${environmentId}:tick-settled`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unread completion labels stable across a minute tick", () => {
    const unread = makeThread({
      id: ThreadId.make("tick-unread"),
      title: "Unread completion",
      lastVisitedAt: isoAt(BASE_MS - 10 * MINUTE_MS),
      latestRun: {
        runId: RunId.make("tick-unread-run"),
        status: "completed",
        requestedAt: isoAt(BASE_MS - 6 * MINUTE_MS),
        startedAt: isoAt(BASE_MS - 6 * MINUTE_MS),
        completedAt: isoAt(BASE_MS - 5 * MINUTE_MS),
        assistantMessageId: null,
      },
    });
    const options = { snoozeEnvironmentIds: new Set<EnvironmentId>() };
    const first = buildTickList([unread], BASE_MS, [], options)[0]!;
    const next = buildTickList([unread], BASE_MS + MINUTE_MS, [], options)[0]!;
    expect(first.type === "v2-thread" && first.timeLabel).toBe("");
    expect(threadListV2ListItemsAreEqual(first, next)).toBe(true);
  });

  it("keeps hour-granularity rows stable across a minute tick when they carry no snooze menu", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const staleReady = makeThread({
        id: ThreadId.make("tick-stale"),
        title: "tick stale",
        latestUserMessageAt: isoAt(BASE_MS - 3 * 60 * MINUTE_MS),
      });
      const atStart = buildTickList([staleReady], BASE_MS, [], {
        snoozeEnvironmentIds: new Set<EnvironmentId>(),
      });
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList([staleReady], BASE_MS + MINUTE_MS, [], {
        snoozeEnvironmentIds: new Set<EnvironmentId>(),
      });
      expect(threadListV2ListItemsAreEqual(atStart[0]!, atNextMinute[0]!)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renders the snoozed countdown row when the wake label advances", () => {
    vi.useFakeTimers();
    try {
      const wakeAt = BASE_MS + 120 * MINUTE_MS;
      const snoozed = makeThread({
        id: ThreadId.make("tick-wake"),
        title: "tick wake",
        snoozedAt: isoAt(BASE_MS - MINUTE_MS),
        snoozedUntil: isoAt(wakeAt),
      });
      const wakeKey = `v2-thread:${environmentId}:tick-wake`;
      const wakeRow = (items: ThreadListV2ListItem[]) => itemsByThreadKey(items).get(wakeKey)!;
      vi.setSystemTime(BASE_MS);
      const atStart = buildTickList([snoozed], BASE_MS, []);
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const stillTwoHours = buildTickList([snoozed], BASE_MS + MINUTE_MS, []);
      expect(threadListV2ListItemsAreEqual(wakeRow(atStart), wakeRow(stillTwoHours))).toBe(true);
      vi.setSystemTime(BASE_MS + 61 * MINUTE_MS);
      const oneHour = buildTickList([snoozed], BASE_MS + 61 * MINUTE_MS, []);
      const oneHourRow = wakeRow(oneHour);
      expect(oneHourRow.type).toBe("v2-thread");
      expect(oneHourRow.type === "v2-thread" && oneHourRow.snoozeWakeLabelText).toBe("59m");
      expect(threadListV2ListItemsAreEqual(wakeRow(stillTwoHours), wakeRow(oneHour))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildThreadListV2ListItems trailing dividers", () => {
  it("follows the final neighbour order, not the pre-splice blocks", () => {
    const activeA = makeThread({ id: ThreadId.make("div-a"), title: "a" });
    const activeB = makeThread({ id: ThreadId.make("div-b"), title: "b" });
    const layout = buildThreadListV2Items({
      threads: [activeA, activeB],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("div-q1"), makePendingTask("div-q2")],
      snoozeLabelNow: NOW,
    });
    const dividers = items.map((item) =>
      item.type === "v2-thread" || item.type === "v2-pending" ? item.showTrailingDivider : "n/a",
    );
    expect(dividers).toEqual([true, false, true, false]);
  });
});

describe("buildThreadListV2ListItems row-state stamps", () => {
  const readyThread = makeThread({
    id: ThreadId.make("stamp-ready"),
    title: "stamp ready",
    latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
  });
  const settledThread = makeThread({
    id: ThreadId.make("stamp-settled"),
    title: "stamp settled",
    settledOverride: "settled",
    settledAt: isoAt(BASE_MS - 3 * 24 * 60 * MINUTE_MS),
  });
  const allEnvironments = new Set<EnvironmentId>([environmentId]);

  it("keeps the settled slim row's swipe snooze menu fresh across a tick", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const atStart = buildTickList([settledThread], BASE_MS, [], {
        snoozeEnvironmentIds: allEnvironments,
      });
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList([settledThread], BASE_MS + MINUTE_MS, [], {
        snoozeEnvironmentIds: allEnvironments,
      });
      const rowAtStart = atStart.find((item) => item.type === "v2-thread")!;
      const rowAtNext = atNextMinute.find((item) => item.type === "v2-thread")!;
      expect(rowAtStart.type === "v2-thread" && rowAtStart.item.variant).toBe("slim");
      expect(rowAtStart.type === "v2-thread" && rowAtStart.snoozePresetMinute).toBe(isoAt(BASE_MS));
      expect(rowAtNext.type === "v2-thread" && rowAtNext.snoozePresetMinute).toBe(
        isoAt(BASE_MS + MINUTE_MS),
      );
      expect(threadListV2ListItemsAreEqual(rowAtStart, rowAtNext)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps the shelf loading-disabled state so recycled headers refresh", () => {
    const loading = buildTickList([settledThread], BASE_MS, [], {
      shelfPreferencesLoading: true,
      snoozeEnvironmentIds: allEnvironments,
    });
    const loaded = buildTickList([settledThread], BASE_MS, [], {
      shelfPreferencesLoading: false,
      snoozeEnvironmentIds: allEnvironments,
    });
    const shelfLoading = loading.find((item) => item.type === "v2-settled-shelf")!;
    const shelfLoaded = loaded.find((item) => item.type === "v2-settled-shelf")!;
    expect(shelfLoading.type === "v2-settled-shelf" && shelfLoading.disabled).toBe(true);
    expect(shelfLoaded.type === "v2-settled-shelf" && shelfLoaded.disabled).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelfLoading, shelfLoaded)).toBe(false);
  });
});

describe("Working section beta", () => {
  const running = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: NOW,
  };
  const finishedAt = (id: string, completedAt: string) =>
    makeThread({
      id: ThreadId.make(id),
      title: id,
      createdAt: "2026-06-01T00:00:00.000Z",
      latestRun: {
        runId: RunId.make(`run-${id}`),
        status: "completed",
        requestedAt: "2026-06-01T00:00:00.000Z",
        startedAt: "2026-06-01T00:00:00.000Z",
        completedAt,
        assistantMessageId: null,
      },
    });
  const threads = [
    finishedAt("finished-early", "2026-06-01T01:00:00.000Z"),
    finishedAt("finished-late", "2026-06-01T03:00:00.000Z"),
    makeThread({ id: ThreadId.make("working"), title: "working", runtime: running }),
    makeThread({
      id: ThreadId.make("asks-approval"),
      title: "asks-approval",
      createdAt: "2026-06-01T02:00:00.000Z",
      runtime: running,
      hasPendingApprovals: true,
    }),
    makeThread({
      id: ThreadId.make("pinned-working"),
      title: "pinned-working",
      runtime: running,
      pinnedAt: "2026-06-01T00:00:00.000Z",
    }),
  ];
  const build = (input: Partial<Parameters<typeof buildThreadListV2Items>[0]> = {}) =>
    buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      now: NOW,
      workingShelfEnabled: true,
      ...input,
    });
  const ids = (layout: ReturnType<typeof buildThreadListV2Items>) =>
    layout.items.map((item) => item.thread.id);

  it("shows working rows as cards when expanded, or only the selected one when collapsed", () => {
    expect(build({ workingShelfExpanded: true }).items.at(-1)).toMatchObject({
      thread: { id: "working" },
      variant: "card",
    });
    expect(ids(build({ selectedThreadKey: `${environmentId}:working` })).at(-1)).toBe("working");
  });

  it("places the shelf after queued tasks and before snoozed and settled threads", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        makeThread({ id: ThreadId.make("working"), title: "working", runtime: running }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "snoozed",
          runtime: running,
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      workingShelfEnabled: true,
      workingShelfExpanded: true,
      snoozedShelfExpanded: true,
    });
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued")],
      workingCount: layout.workingCount,
      workingShelfExpanded: true,
      workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
      snoozedCount: layout.snoozedCount,
      snoozedShelfExpanded: true,
      snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });
    expect(
      items.map((item) =>
        item.type === "v2-thread"
          ? item.item.thread.id
          : item.type === "v2-pending"
            ? item.pendingTask.title
            : item.type,
      ),
    ).toEqual([
      "active",
      "queued",
      "v2-working-shelf",
      "working",
      "v2-snoozed-shelf",
      "snoozed",
      "v2-settled-shelf",
      "settled",
    ]);
  });
});
