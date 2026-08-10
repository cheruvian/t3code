import type { OrchestrationCommand } from "@t3tools/contracts";

export const requiresDrainAdmission = (command: OrchestrationCommand) =>
  command.type === "thread.turn.start" || command.type === "thread.runtime-mode.set";
