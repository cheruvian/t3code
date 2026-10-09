import { quickCommandNavigation as navigateQuickCommands } from "@t3tools/shared/quickCommandNavigation";
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

export function quickCommandNavigation(items: readonly ComposerCommandItem[], prefix: string) {
  return navigateQuickCommands(items, prefix, quickCommandName);
}

export function shouldDismissQuickPicker(translationX: number, translationY: number) {
  return translationY >= 48 && translationY > Math.abs(translationX);
}
