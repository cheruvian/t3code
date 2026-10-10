import type { SavedPrompt } from "@t3tools/contracts";

export const STARTER_SAVED_PROMPTS: readonly SavedPrompt[] = [
  {
    id: "commit-changes",
    name: "Commit changes",
    behavior: "insert",
    text: "Commit all local changes using a Conventional Commit message.",
  },
  {
    id: "push-to-main",
    name: "Push to main",
    behavior: "insert",
    text: "Push these changes to origin/main.",
  },
  {
    id: "review-concerns",
    name: "Review concerns",
    behavior: "insert",
    text: "Are there any other issues, improvements, bugs, or concerns you noticed while making these changes?",
  },
];

/** Saved prompts expand locally; the provider receives the editable text. */
export function savedPromptItems(prompts: readonly SavedPrompt[], query = "") {
  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/^prompt:/, "");
  return prompts
    .filter((prompt) =>
      `${prompt.name}\n${prompt.name.toLowerCase().replace(/\s+/g, "-")}\n${prompt.text}`
        .toLowerCase()
        .includes(normalized),
    )
    .map((prompt) => ({
      id: `saved-prompt:${prompt.id}`,
      type: "saved-prompt" as const,
      prompt,
      label: `/prompt:${prompt.name.toLowerCase().replace(/\s+/g, "-")}`,
      description: `${prompt.behavior === "send" ? "Send immediately" : "Insert into composer"} · ${prompt.text}`,
    }));
}
