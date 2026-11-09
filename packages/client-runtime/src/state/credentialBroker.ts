import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
export function createCredentialBrokerAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "credential-broker:state",
    tag: WS_METHODS.credentialBrokerSubscribe,
    idleTtlMs: 0,
  });
  return {
    state,
    pendingThreadIdsAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => {
        const result = get(state({ environmentId, input: { viewId: "thread-credential-status" } }));
        return AsyncResult.isSuccess(result)
          ? result.value.requests.flatMap((request) =>
              request.origin?.environmentId === environmentId &&
              ["pending", "awaiting_unlock", "searching"].includes(request.state)
                ? [request.origin.threadId]
                : [],
            )
          : [];
      }),
    ),
    action: createEnvironmentRpcCommand(runtime, {
      label: "credential-broker:action",
      tag: WS_METHODS.credentialBrokerAction,
    }),
  };
}

export function credentialDialogAttentionKey(
  requests: ReadonlyArray<{
    readonly requestId: string;
    readonly origin?: { readonly environmentId: string; readonly threadId: string } | undefined;
  }>,
  environmentId: string,
  viewedThread: { readonly environmentId: string; readonly threadId: string } | null,
): string | null {
  const ids = requests
    .filter(
      (request) =>
        !request.origin ||
        (environmentId === viewedThread?.environmentId &&
          request.origin.environmentId === viewedThread.environmentId &&
          request.origin.threadId === viewedThread.threadId),
    )
    .map((request) => request.requestId)
    .sort();
  return ids.length ? JSON.stringify(ids) : null;
}

export interface CredentialDialogPresentation {
  readonly viewKey: string;
  readonly attentionKey: string | null;
  readonly open: boolean;
}

export function reconcileCredentialDialog(
  previous: CredentialDialogPresentation,
  viewKey: string,
  attentionKey: string | null,
  matchesViewedThread = true,
): CredentialDialogPresentation {
  return previous.viewKey === viewKey && previous.attentionKey === attentionKey
    ? previous
    : {
        viewKey,
        attentionKey,
        open:
          (attentionKey !== null &&
            (previous.attentionKey !== attentionKey || matchesViewedThread)) ||
          (previous.viewKey === viewKey && previous.open),
      };
}
