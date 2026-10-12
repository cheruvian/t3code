import { createCredentialBrokerAtoms } from "@t3tools/client-runtime/state/credentialBroker";
import { connectionAtomRuntime } from "../connection/runtime";
export const credentialBroker = createCredentialBrokerAtoms(connectionAtomRuntime);
