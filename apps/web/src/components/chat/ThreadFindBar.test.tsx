// @vitest-environment jsdom
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ThreadFindBar } from "./ThreadFindBar";
import { useThreadFind } from "./useThreadFind";
import { requestThreadFindOpen } from "./threadFindActionBus";

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
const search = vi.hoisted(() => vi.fn());
vi.mock("~/state/orchestration", () => ({ orchestrationEnvironment: { threadFind: search } }));
vi.mock("~/state/queries", () => ({ useDebouncedValue: <T,>(value: T) => value }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

it("finds loaded messages without server search or rendered rows and wraps navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const threadId = ThreadId.make("thread:local-find");
  const content: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems" | "runs"> = {
    runs: [],
    visibleTurnItems: ["Alpha earlier", "unrelated", "alpha later"].map((text, index) => ({
      position: index,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: TurnItemId.make(`item-${index}`),
      item: {
        id: TurnItemId.make(`item-${index}`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        type: "assistant_message",
        messageId: MessageId.make(`message-${index}`),
        text,
        streaming: false,
      },
    })),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  let find: ReturnType<typeof useThreadFind>;
  function Probe() {
    const state = useThreadFind({
      thread: { environmentId: EnvironmentId.make("offline"), threadId },
      enabled: true,
      serverSearch: false,
      content,
    });
    useLayoutEffect(() => {
      find = state;
    });
    return (
      <ThreadFindBar
        {...state.barProps}
        onClose={() => {
          state.close();
          onClose();
        }}
      />
    );
  }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => requestThreadFindOpen());
    const input = host.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "ALPHA",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector('[aria-live="polite"]')!.textContent).toBe("1/2");
    expect(find!.timelineProps.activeFindMatch?.entryId).toBe("message-0");
    for (const [shiftKey, entryId] of [
      [false, "message-2"],
      [false, "message-0"],
      [true, "message-2"],
    ] as const) {
      await act(async () =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true }),
        ),
      );
      expect(find!.timelineProps.activeFindMatch?.entryId).toBe(entryId);
    }
    expect(search).not.toHaveBeenCalled();
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(host.querySelector('[role="search"]')).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
