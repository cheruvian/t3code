import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
export function createCredentialBrokerAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "credential-broker:state",
      tag: WS_METHODS.credentialBrokerSubscribe,
      idleTtlMs: 0,
    }),
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
): CredentialDialogPresentation {
  return previous.viewKey === viewKey && previous.attentionKey === attentionKey
    ? previous
    : {
        viewKey,
        attentionKey,
        open: attentionKey !== null || (previous.viewKey === viewKey && previous.open),
      };
}
