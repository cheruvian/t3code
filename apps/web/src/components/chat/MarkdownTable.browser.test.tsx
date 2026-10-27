import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { useUiStateStore } from "../../uiStateStore";
import { TooltipProvider } from "../ui/tooltip";
import { MarkdownTable } from "./MarkdownTable";

const settings = vi.hoisted(() => ({ wordWrap: false }));
vi.mock(import("../../hooks/useSettings"), () => ({
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: settings.wordWrap }),
  useClientSettings: <T = ClientSettings,>(select?: (value: ClientSettings) => T) => {
    const value = { ...DEFAULT_CLIENT_SETTINGS, wordWrap: settings.wordWrap };
    return select ? select(value) : (value as T);
  },
}));
function setup(wordWrap: boolean) {
  settings.wordWrap = wordWrap;
  useUiStateStore.setState({ wrapTableCells: null });
}

it.each([true, false])(
  "honors the saved table-only wrapping override %s and live changes",
  async (override) => {
    setup(!override);
    useUiStateStore.setState({ wrapTableCells: override });
    await using screen = await render(
      <TooltipProvider>
        <MarkdownTable>
          <tbody>
            <tr>
              <td>Long table text</td>
            </tr>
          </tbody>
        </MarkdownTable>
      </TooltipProvider>,
    );
    await expect
      .element(screen.container.querySelector<HTMLElement>(".chat-markdown-table-container")!)
      .toHaveAttribute("data-expanded", String(override));
    await act(() => useUiStateStore.setState({ wrapTableCells: !override }));
    await expect
      .element(screen.container.querySelector<HTMLElement>(".chat-markdown-table-container")!)
      .toHaveAttribute("data-expanded", String(!override));
    await act(() => useUiStateStore.setState({ wrapTableCells: null }));
    await expect
      .element(screen.container.querySelector<HTMLElement>(".chat-markdown-table-container")!)
      .toHaveAttribute("data-expanded", String(!override));
  },
);
