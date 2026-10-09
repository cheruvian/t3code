import { describe, expect, it } from "vite-plus/test";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import {
  quickCommandGroup,
  quickCommandNavigation,
  shouldDismissQuickPicker,
} from "./composerQuickCommands";

const skill = (name: string): ComposerCommandItem => ({
  id: name,
  type: "skill",
  skill: { name, enabled: true, path: `/skills/${name}/SKILL.md` },
  label: name,
  description: "",
});

describe("quick command prefix navigation", () => {
  const skills = [
    "knowledge-base",
    "knowledge-curator",
    "knowledge-ingest",
    "knowledge-research",
    "test-case-design",
    "test-t3-app",
    "verify-change",
    "dev-loop",
  ].map(skill);
  it("ranks letter branches by match count with alphabetical ties", () => {
    const root = quickCommandNavigation(skills, "");
    expect(root.branches.map(({ letter, count }) => [letter, count])).toEqual([
      ["k", 4],
      ["t", 2],
      ["d", 1],
      ["v", 1],
    ]);
    expect(root.matches[0]?.id).toBe("knowledge-base");
  });
  it("skips the shared namespace and exposes only meaningful next letters", () => {
    const branch = quickCommandNavigation(skills, "").branches[0];
    expect(branch?.prefix).toBe("knowledge-");
    const narrowed = quickCommandNavigation(skills, branch!.prefix);
    expect(narrowed.branches.map(({ letter }) => letter)).toEqual(["b", "c", "i", "r"]);
    const leaf = narrowed.branches.find(({ letter }) => letter === "i")!;
    expect(quickCommandNavigation(skills, leaf.prefix)).toEqual({
      matches: [skill("knowledge-ingest")],
      branches: [],
    });
  });
  it("keeps an exact shorter command reachable alongside longer names", () => {
    const result = quickCommandNavigation([skill("test"), skill("test-t3-app")], "test");
    expect(result.matches.map(({ id }) => id)).toContain("test");
    expect(result.branches[0]?.prefix).toBe("test-t3-app");
  });
  it("keeps Unicode letters intact when jumping through shared prefixes", () => {
    const items = [skill("add-🐱"), skill("add-🐶")];
    const root = quickCommandNavigation(items, "");
    expect(root.branches[0]?.prefix).toBe("add-");
    expect(quickCommandNavigation(items, "add-").branches.map((branch) => branch.letter)).toEqual([
      "🐱",
      "🐶",
    ]);
  });
  it("does not mutate the provider's catalog or mix categories", () => {
    const original = [...skills];
    quickCommandNavigation(skills, "");
    expect(skills).toEqual(original);
    expect(quickCommandGroup(skills[0]!)).toBe("skills");
    expect(
      quickCommandGroup({
        id: "prompt",
        type: "saved-prompt",
        prompt: { id: "commit", name: "Commit", text: "Commit changes", behavior: "insert" },
        label: "Commit",
        description: "",
      }),
    ).toBe("saved");
    expect(quickCommandNavigation(skills, "missing")).toEqual({ matches: [], branches: [] });
  });
});

it.each([
  [0, 48, true],
  [20, 60, true],
  [60, 20, false],
  [-80, 50, false],
  [0, -80, false],
  [0, 30, false],
])("dismisses only a sufficiently long downward gesture (%s, %s)", (x, y, expected) => {
  expect(shouldDismissQuickPicker(x, y)).toBe(expected);
});
