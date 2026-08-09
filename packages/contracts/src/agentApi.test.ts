import { describe, expect, it } from "vite-plus/test";

import { AGENT_API_INVENTORY, ORCHESTRATION_WS_METHODS, WS_METHODS } from "./index.ts";

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
});
