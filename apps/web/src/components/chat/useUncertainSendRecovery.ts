import type { MessageId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveUncertainSendRecovery } from "../ChatView.logic";
import { Atom } from "effect/reactivity";
import type { ComposerThreadDraftState, ComposerThreadTarget } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";

interface UncertainSend {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly restoredDraft: ComposerThreadDraftState;
}
const uncertainSendAtom = Atom.family((_routeKey: string) =>
  Atom.make<UncertainSend | null>(null).pipe(Atom.keepAlive),
);
export function rememberUncertainSend(routeKey: string, send: UncertainSend) {
  appAtomRegistry.set(uncertainSendAtom(routeKey), send);
}
export function useUncertainSendRecovery(input: {
  readonly routeKey: string;
  readonly threadId: ThreadId | null;
  readonly messages: ReadonlyArray<{ readonly id: MessageId }>;
  readonly target: ComposerThreadTarget;
  readonly onClear: (threadId: ThreadId) => void;
}) {
  const atom = uncertainSendAtom(input.routeKey);
  const send = useAtomValue(atom);
  const onClear = useStableCallback(input.onClear);
  // oxlint-disable-next-line t3code/react-effect-budget -- Reconcile server acknowledgements with the external persisted composer store.
  useEffect(() => {
    if (!send || send.threadId !== input.threadId) return;
    const store = useComposerDraftStore.getState();
    const recovery = resolveUncertainSendRecovery({
      messageId: send.messageId,
      serverMessageIds: input.messages.map((message) => message.id),
      restoredDraft: send.restoredDraft,
      currentDraft: store.getComposerDraft(input.target),
    });
    if (recovery === "waiting") return;
    appAtomRegistry.set(atom, null);
    if (recovery === "preserve") return;
    store.clearComposerContent(input.target);
    onClear(send.threadId);
  }, [atom, send, input.threadId, input.messages, input.target, onClear]);
}
