import { describe, expect, it } from "vite-plus/test";

import { requiresDrainAdmission } from "./serverDrainAdmission.ts";

describe("requiresDrainAdmission", () => {
  it("gates new turns and replacement-triggering runtime mode changes", () => {
    expect(requiresDrainAdmission({ type: "thread.turn.start" } as never)).toBe(true);
    expect(requiresDrainAdmission({ type: "thread.runtime-mode.set" } as never)).toBe(true);
  });

  it("keeps completion-driving responses admitted", () => {
    expect(requiresDrainAdmission({ type: "thread.turn.interrupt" } as never)).toBe(false);
    expect(requiresDrainAdmission({ type: "thread.approval.respond" } as never)).toBe(false);
    expect(requiresDrainAdmission({ type: "thread.user-input.respond" } as never)).toBe(false);
  });
});
