// @vitest-environment jsdom
import { MessageId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { TimelineEntry } from "~/session-logic";
import { ThreadFindBar } from "./ThreadFindBar";

it("finds loaded messages regardless of rendered rows and wraps navigation", async () => {
  const entries: TimelineEntry[] = ["Alpha earlier", "unrelated", "alpha later"].map(
    (text, index) => ({
      kind: "message",
      id: `message-${index}`,
      createdAt: "2026-01-01T00:00:00Z",
      message: {
        id: MessageId.make(`message-${index}`),
        role: "assistant",
        text,
        runId: null,
        streaming: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSelect = vi.fn();
  const onClose = vi.fn();
  try {
    await act(async () =>
      root.render(<ThreadFindBar entries={entries} onSelect={onSelect} onClose={onClose} />),
    );
    const shortcut = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => document.dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(true);
    const input = host.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "ALPHA",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector('[role="status"]')!.textContent).toBe("1/2 messages");
    expect(onSelect).toHaveBeenLastCalledWith(entries[0]);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSelect).toHaveBeenLastCalledWith(entries[2]);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSelect).toHaveBeenLastCalledWith(entries[0]);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      ),
    );
    expect(onSelect).toHaveBeenLastCalledWith(entries[2]);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(host.querySelector('[role="search"]')).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
