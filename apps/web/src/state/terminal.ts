import type * as Layer from "effect/Layer";
import type { Atom } from "effect/reactivity";
import { createTerminalEnvironmentAtoms } from "@t3tools/client-runtime/state/terminal";

import { connectionAtomRuntime } from "../connection/runtime";

type ConnectionLayer = Atom.Type<typeof connectionAtomRuntime.layer>;

export const terminalEnvironment: ReturnType<
  typeof createTerminalEnvironmentAtoms<Layer.Success<ConnectionLayer>, Layer.Error<ConnectionLayer>>
> = createTerminalEnvironmentAtoms(connectionAtomRuntime);
