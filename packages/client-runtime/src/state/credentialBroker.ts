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
