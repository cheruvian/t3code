import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { rememberUncertainSend, useUncertainSendRecovery } from "./useUncertainSendRecovery";

function Harness(input: Parameters<typeof useUncertainSendRecovery>[0]) {
  useUncertainSendRecovery(input);
  const prompt = useComposerDraftStore(
    (state) => state.getComposerDraft(input.target)?.prompt ?? "",
  );
  return <output aria-label="Draft">{prompt}</output>;
}

it.each([false, true])(
  "reconciles exact send acknowledgement while preserving newer work: %s",
  async (edited) => {
    const threadId = ThreadId.make(`uncertain-${edited}`);
    const target = scopeThreadRef(EnvironmentId.make("uncertain-env"), threadId);
    const routeKey = `uncertain-route-${edited}`;
    const messageId = MessageId.make("sent-message");
    const onClear = vi.fn();
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "sent text");
    const restoredDraft = store.getComposerDraft(target)!;
    const ui = (messages: ReadonlyArray<{ id: MessageId }>) => (
      <AppAtomRegistryProvider>
        <Harness
          routeKey={routeKey}
          threadId={threadId}
          target={target}
          messages={messages}
          onClear={onClear}
        />
      </AppAtomRegistryProvider>
    );
    await using screen = await render(ui([]));
    await act(() => rememberUncertainSend(routeKey, { threadId, messageId, restoredDraft }));
    await screen.rerender(ui([{ id: MessageId.make("same-text-different-id") }]));
    await expect.element(screen.getByLabelText("Draft")).toHaveTextContent("sent text");
    if (edited) await act(() => store.setPrompt(target, "new work"));
    await screen.rerender(ui([{ id: messageId }]));
    if (edited) await expect.element(screen.getByLabelText("Draft")).toHaveTextContent("new work");
    else await expect.element(screen.getByLabelText("Draft")).toBeEmptyDOMElement();
    if (edited) expect(onClear).not.toHaveBeenCalled();
    else expect(onClear).toHaveBeenCalledExactlyOnceWith(threadId);
  },
);

it("retains a pending acknowledgement across mounting another thread", async () => {
  const threadId = ThreadId.make("uncertain-remount");
  const target = scopeThreadRef(EnvironmentId.make("uncertain-env"), threadId);
  const routeKey = "uncertain-remount-route";
  const messageId = MessageId.make("uncertain-remount-message");
  const onClear = vi.fn();
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, "waiting draft");
  rememberUncertainSend(routeKey, {
    threadId,
    messageId,
    restoredDraft: store.getComposerDraft(target)!,
  });
  const ui = (activeThreadId: ThreadId) => (
    <AppAtomRegistryProvider>
      <Harness
        routeKey={routeKey}
        threadId={activeThreadId}
        target={target}
        messages={[{ id: messageId }]}
        onClear={onClear}
      />
    </AppAtomRegistryProvider>
  );
  await using screen = await render(ui(ThreadId.make("another-thread")));
  await expect.element(screen.getByLabelText("Draft")).toHaveTextContent("waiting draft");
  expect(onClear).not.toHaveBeenCalled();
  await screen.rerender(ui(threadId));
  await expect.element(screen.getByLabelText("Draft")).toBeEmptyDOMElement();
  expect(onClear).toHaveBeenCalledExactlyOnceWith(threadId);
});
