// @vitest-environment jsdom

import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { MermaidDiagram } from "./MermaidDiagram";

it("renders real diagrams in both themes and recovers after invalid source", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no SVG layout; only geometry is substituted, not Mermaid rendering.
  const geometry = vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    bottom: 20,
    right: 100,
    toJSON: () => ({}),
  });
  const originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
  const originalLength = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getComputedTextLength",
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value: () => 100,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const source = "flowchart LR\nA[Start] --> B[Finish]";
  const render = (code: string, both = false) =>
    act(async () => {
      root.render(
        <Suspense fallback={<p>Rendering</p>}>
          <MermaidDiagram source={code} theme="light" onExpand={() => {}} />
          {both ? <MermaidDiagram source={code} theme="dark" onExpand={() => {}} /> : null}
        </Suspense>,
      );
    });
  try {
    await render(source, true);
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelectorAll("svg")).toHaveLength(2);
    });
    const diagrams = [...container.querySelectorAll("svg")];
    expect(diagrams.map((diagram) => diagram.textContent)).toEqual([
      expect.stringContaining("Start"),
      expect.stringContaining("Finish"),
    ]);
    expect(diagrams[0]!.id).not.toBe(diagrams[1]!.id);

    await render("not a diagram");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain("Unable to render diagram");
    });
    expect(container.querySelector("pre")?.textContent).toBe("not a diagram");

    await render("sequenceDiagram\nAlice->>Bob: Hello");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector("svg")?.textContent).toContain("Hello");
    });
    expect(container.textContent).not.toContain("Unable to render diagram");
    expect(document.querySelectorAll('[id^="dmermaid-diagram-"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    geometry.mockRestore();
    for (const [key, descriptor] of [
      ["getBBox", originalBBox],
      ["getComputedTextLength", originalLength],
    ] as const) {
      if (descriptor) Object.defineProperty(SVGElement.prototype, key, descriptor);
      else Reflect.deleteProperty(SVGElement.prototype, key);
    }
    vi.unstubAllGlobals();
  }
});
