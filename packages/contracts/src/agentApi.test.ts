import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_API_INVENTORY,
  AGENT_EXPOSED_API_NAMES,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "./index.ts";

describe("agent API inventory", () => {
  it("includes every typed RPC and orchestration method exactly once", () => {
    const expected = [...Object.values(WS_METHODS), ...Object.values(ORCHESTRATION_WS_METHODS)];
    const names = AGENT_API_INVENTORY.map((operation) => operation.name);
    expect(names).toHaveLength(new Set(names).size);
    expect(names).toEqual(expect.arrayContaining(expected));
  });

  it("marks destructive operations explicitly", () => {
    for (const operation of AGENT_API_INVENTORY.filter((entry) =>
      /remove|delete|revert/.test(entry.name),
    )) {
      expect(operation.mutability).toBe("destructive");
    }
  });

  it("only advertises implemented operations as agent-exposed", () => {
    const names = AGENT_API_INVENTORY.map((operation) => operation.name);
    // The former project registry RPCs never existed on the wire; project
    // management is orchestration commands through dispatchCommand.
    expect(names).not.toContain("projects.list");
    expect(names).not.toContain("projects.add");
    expect(names).not.toContain("projects.remove");
    expect(AGENT_EXPOSED_API_NAMES).toContain(ORCHESTRATION_WS_METHODS.dispatchCommand);
    expect(AGENT_EXPOSED_API_NAMES).toContain(ORCHESTRATION_WS_METHODS.subscribeShell);
  });

  it("marks supported helper configuration APIs with their narrow scope", () => {
    for (const name of [
      WS_METHODS.serverGetSettings,
      WS_METHODS.serverUpdateSettings,
      WS_METHODS.serverUpsertKeybinding,
      WS_METHODS.serverRemoveKeybinding,
    ]) {
      expect(AGENT_API_INVENTORY.find((operation) => operation.name === name)).toMatchObject({
        exposure: "agent",
        scope: "configuration",
      });
    }
  });
});
