import type { ComposerCommandItem } from "./ComposerCommandPopover";

export type QuickCommandGroup = "saved" | "commands" | "skills";

export function quickCommandGroup(item: ComposerCommandItem): QuickCommandGroup | null {
  switch (item.type) {
    case "saved-prompt":
      return "saved";
    case "skill":
      return "skills";
    case "slash-command":
    case "provider-slash-command":
      return "commands";
    default:
      return null;
  }
}

export function quickCommandName(item: ComposerCommandItem): string {
  switch (item.type) {
    case "saved-prompt":
      return item.prompt.name.toLowerCase().replace(/\s+/g, "-");
    case "skill":
      return item.skill.name.toLowerCase();
    case "slash-command":
      return item.command.toLowerCase();
    case "provider-slash-command":
      return item.command.name.toLowerCase();
    default:
      return item.label.toLowerCase();
  }
}

function commonPrefix(names: string[]) {
  let prefix = Array.from(names[0] ?? "");
  for (const name of names.slice(1)) {
    const characters = Array.from(name);
    let length = 0;
    while (length < prefix.length && prefix[length] === characters[length]) length++;
    prefix = prefix.slice(0, length);
  }
  return prefix.join("");
}

/** Jump between meaningful name splits, skipping shared namespaces such as knowledge-. */
export function quickCommandNavigation(items: readonly ComposerCommandItem[], prefix: string) {
  const matches = items.filter((item) => quickCommandName(item).startsWith(prefix));
  const groups = new Map<string, ComposerCommandItem[]>();
  if (matches.length > 1) {
    for (const item of matches) {
      const letter = Array.from(quickCommandName(item).slice(prefix.length))[0];
      if (!letter) continue;
      const group = groups.get(letter) ?? [];
      group.push(item);
      groups.set(letter, group);
    }
  }
  const branches = Array.from(groups, ([letter, entries]) => ({
    letter,
    count: entries.length,
    prefix: commonPrefix(entries.map(quickCommandName)),
  })).sort((a, b) => b.count - a.count || a.letter.localeCompare(b.letter));
  const ranked = matches.sort((a, b) => {
    const aName = quickCommandName(a);
    const bName = quickCommandName(b);
    const aLetter = Array.from(aName.slice(prefix.length))[0] ?? "";
    const bLetter = Array.from(bName.slice(prefix.length))[0] ?? "";
    return (
      (groups.get(bLetter)?.length ?? 0) - (groups.get(aLetter)?.length ?? 0) ||
      aName.localeCompare(bName)
    );
  });
  return { matches: ranked, branches };
}

export function shouldDismissQuickPicker(translationX: number, translationY: number) {
  return translationY >= 48 && translationY > Math.abs(translationX);
}
