import { expect, it, vi } from "vite-plus/test";
import { OPEN_BROWSER_FIND_SCRIPT } from "@t3tools/shared/browserFind";

const find = vi.fn(() => true);

const open = () => {
  Function(OPEN_BROWSER_FIND_SCRIPT)();
  return document.getElementById("__t3_browser_find__")!.shadowRoot!;
};
it("reuses the find toolbar and restores page focus when closed", () => {
  using _fixture = setup();
  const previous = document.getElementById("previous")!;
  previous.focus();
  const root = open();
  expect(open()).toBe(root);
  expect(document.querySelectorAll("#__t3_browser_find__")).toHaveLength(1);
  root
    .querySelector("input")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.getElementById("__t3_browser_find__")).toBeNull();
  expect(document.activeElement).toBe(previous);
});
it("searches as the query changes, wraps, and supports previous matches", () => {
  using _fixture = setup();
  const root = open();
  const input = root.querySelector("input")!;
  input.value = "needle";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(find).toHaveBeenLastCalledWith("needle", false, false, true);
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
  );
  expect(find).toHaveBeenLastCalledWith("needle", false, true, true);
  find.mockReturnValue(false);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(root.querySelector("output")!.textContent).toBe("No matches");
});

function setup() {
  const previous = document.createElement("button");
  previous.id = "previous";
  previous.textContent = "Page";
  document.body.append(previous);
  vi.stubGlobal("find", find);
  find.mockReset().mockReturnValue(true);
  return {
    [Symbol.dispose]() {
      document.getElementById("__t3_browser_find__")?.remove();
      document.getElementById("previous")?.remove();
      vi.unstubAllGlobals();
    },
  };
}
