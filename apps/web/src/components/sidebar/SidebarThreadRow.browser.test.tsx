import { ProviderDriverKind } from "@t3tools/contracts";
import { render } from "../../../test/render";
import "~/index.css";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarThreadRow } from "./SidebarThreadRow";

vi.mock("../../state/terminalSessions", () => ({ useThreadRunningTerminalIds: () => [] }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-01-01T00:05" }));
vi.mock("../../hooks/useNowSecond", () => ({ useNowSecond: () => 0 }));
vi.mock("~/hooks/useDeadline", () => ({ useDeadlinePassed: () => false }));
vi.mock("~/hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("../CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("../EnvironmentIcon", () => ({ EnvironmentIcon: () => null }));
vi.mock("../ThreadHoverCard", () => ({
  ThreadHoverCard: () => null,
  ThreadHoverCardPopup: () => null,
}));
type Props = ComponentProps<typeof SidebarThreadRow>;
function setup() {
  const props: Props = {
    thread: makeThreadFixture({
      title: "Compact restoration",
      lastVisitedAt: "2026-01-01T00:00:00.000Z",
    }),
    variant: "slim",
    variantAction: "settle",
    settlementSupported: true,
    snoozeSupported: false,
    pinningSupported: false,
    isPinned: false,
    dropVerb: null,
    dragOverPinned: false,
    sweepAction: null,
    snoozeWakeLabelText: null,
    wokeAt: null,
    isActive: false,
    isRouteThread: false,
    openPullRequestsInRightPanel: false,
    jumpLabel: null,
    currentEnvironmentId: null,
    environmentLabel: null,
    environmentMachine: "desktop",
    scratchMachineLabel: null,
    project: null,
    projectDisplayName: null,
    providerEntryByInstanceId: new Map(),
    timestampFormat: "locale",
    isRenaming: false,
    renamingTitle: "",
    onThreadClick: vi.fn(),
    onThreadActivate: vi.fn(),
    onStartRename: vi.fn(),
    onRenameTitleChange: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onContextMenu: vi.fn(),
    onSettle: vi.fn(),
    onActionSweepStart: vi.fn(),
    onUnsettle: vi.fn(),
    onSnooze: vi.fn(),
    onUnsnooze: vi.fn(),
    onUnpin: vi.fn(),
    onAcknowledgeWoke: vi.fn(),
  };
  return props;
}

it("follows submitted, running, completion, read, and background waiting in the actual slim row", async () => {
  const props = setup();
  await using screen = await render(<SidebarThreadRow {...props} />);
  using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.setSystemTime("2026-01-01T00:03:00.000Z");
  const update = (patch: Partial<Props["thread"]>) =>
    screen.rerender(<SidebarThreadRow {...props} thread={{ ...props.thread, ...patch }} />);
  await update({ latestUserMessageAt: "2026-01-01T00:03:00.000Z", latestRun: null });
  await expect.element(screen.getByRole("img", { name: "Working", exact: true })).toBeVisible();
  for (const status of ["preparing", "queued", "starting", "running"] as const) {
    await update({
      runtime: { ...props.thread.runtime, status } as NonNullable<Props["thread"]["runtime"]>,
    });
    await expect.element(screen.getByRole("img", { name: "Working", exact: true })).toBeVisible();
  }
  const completedAt = "2026-01-01T00:01:00.000Z";
  const latestRun = { ...props.thread.latestRun, status: "completed", completedAt } as NonNullable<
    Props["thread"]["latestRun"]
  >;
  await update({ runtime: null, latestRun });
  await expect.element(screen.getByRole("img", { name: "Done", exact: true })).toBeVisible();
  await update({ runtime: null, latestRun, lastVisitedAt: completedAt });
  await expect.element(screen.getByRole("img", { name: "Done", exact: true })).toBeVisible();
  for (const lastVisitedAt of ["2026-01-01T00:00:00.000Z", completedAt]) {
    await update({
      runtime: { ...props.thread.runtime, status: "idle" } as NonNullable<
        Props["thread"]["runtime"]
      >,
      latestRun,
      lastVisitedAt,
    });
    await expect.element(screen.getByRole("img", { name: "Waiting", exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("img", { name: "Done", exact: true }))
      .not.toBeInTheDocument();
  }
  await update({
    runtime: { ...props.thread.runtime, status: "idle" } as NonNullable<Props["thread"]["runtime"]>,
    latestRun,
    pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", description: "Watch build" }],
  });
  await expect.element(screen.getByRole("img", { name: "Done", exact: true })).toBeVisible();
  await update({
    runtime: { ...props.thread.runtime, status: "idle" } as NonNullable<Props["thread"]["runtime"]>,
    latestRun,
    lastVisitedAt: completedAt,
    pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", description: "Watch build" }],
  });
  await expect.element(screen.getByRole("img", { name: "Waiting", exact: true })).toBeVisible();
  await update({
    runtime: { ...props.thread.runtime, status: "idle" } as NonNullable<Props["thread"]["runtime"]>,
    latestUserMessageAt: "2026-01-01T00:03:00.000Z",
    latestRun: { ...latestRun, status: "queued", requestedAt: "2026-01-01T00:03:00.000Z" },
  });
  await expect.element(screen.getByRole("img", { name: "Waiting", exact: true })).toBeVisible();
  for (const variantAction of ["unsettle", "unsnooze"] as const) {
    await screen.rerender(
      <SidebarThreadRow
        {...props}
        variantAction={variantAction}
        thread={{ ...props.thread, runtime: null, latestRun, lastVisitedAt: completedAt }}
      />,
    );
    await expect.element(screen.getByRole("img", { name: "Done", exact: true })).toBeVisible();
  }
});

it("renders the configured provider profile in the slim row", async () => {
  const props = setup();
  const instanceId = props.thread.modelSelection.instanceId;
  props.providerEntryByInstanceId = new Map([
    [
      instanceId,
      {
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        enabled: true,
        displayName: "Work Codex",
        accentColor: "#ff8800",
        models: [],
      },
    ],
  ]);
  await using screen = await render(<SidebarThreadRow {...props} />);
  await expect.element(screen.getByTestId("sidebar-row-slim")).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "Work Codex", exact: true })).toBeVisible();
  await expect.element(screen.getByText("WC", { exact: true })).toBeVisible();
  props.providerEntryByInstanceId = new Map([
    [
      instanceId,
      {
        ...props.providerEntryByInstanceId.get(instanceId)!,
        displayName: "Personal Codex",
        accentColor: "#9966cc",
      },
    ],
  ]);
  await screen.rerender(<SidebarThreadRow {...props} />);
  await expect.element(screen.getByText("PC", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("WC", { exact: true })).not.toBeInTheDocument();
});

it("preserves special states and a single wake indicator", async () => {
  const props = setup();
  await using screen = await render(<SidebarThreadRow {...props} />);
  const runtime = (status: "running" | "failed", lastErrorClass: "usage_limit" | null = null) =>
    ({ ...props.thread.runtime, status, lastErrorClass }) as NonNullable<
      Props["thread"]["runtime"]
    >;
  const cases: ReadonlyArray<[string, Partial<Props["thread"]>]> = [
    ["Approval", { hasPendingApprovals: true }],
    ["Input", { hasPendingUserInput: true }],
    ["Request", { pendingGuestMessageCount: 1 }],
    ["Failed", { runtime: runtime("failed") }],
    ["Limited", { runtime: runtime("failed", "usage_limit") }],
    [
      "Goal",
      {
        runtime: runtime("running"),
        goal: { ...props.thread.goal, status: "active" } as NonNullable<Props["thread"]["goal"]>,
      },
    ],
    ["Waiting", { runtime: runtime("running"), blockedOnThreadWait: true }],
  ];
  for (const [label, patch] of cases) {
    await screen.rerender(<SidebarThreadRow {...props} thread={{ ...props.thread, ...patch }} />);
    await expect.element(screen.getByRole("img", { name: label, exact: true })).toBeVisible();
  }
  await screen.rerender(<SidebarThreadRow {...props} wokeAt="2026-01-01T00:01:00.000Z" />);
  await expect
    .element(screen.getByRole("button", { name: "Dismiss Woke notification" }))
    .toBeVisible();
  await screen.rerender(
    <SidebarThreadRow {...props} variantAction="unsnooze" snoozeWakeLabelText="Tomorrow" />,
  );
  await expect.element(screen.getByText("Tomorrow", { exact: true })).toBeVisible();
});
