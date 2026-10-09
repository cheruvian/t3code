import { describe, expect, it } from "vite-plus/test";
import { savedPromptItems, STARTER_SAVED_PROMPTS } from "./savedPrompts.ts";

describe("saved prompt suggestions", () => {
  it("matches the displayed slash name and ordinary name or prompt text", () => {
    for (const query of [
      "commit changes",
      "commit-changes",
      "prompt:commit-changes",
      "conventional",
    ]) {
      expect(savedPromptItems(STARTER_SAVED_PROMPTS, query).map((item) => item.prompt.id)).toEqual([
        "commit-changes",
      ]);
    }
    expect(savedPromptItems(STARTER_SAVED_PROMPTS, "unrelated")).toEqual([]);
  });

  it("makes immediate send visible before selection", () => {
    const prompt = { ...STARTER_SAVED_PROMPTS[0]!, behavior: "send" as const };
    expect(savedPromptItems([prompt])[0]?.description).toBe(`Send immediately · ${prompt.text}`);
  });
});
