// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { renderMermaidDiagram } from "./mermaidRendering";

beforeAll(() => {
  // jsdom does not implement the SVG geometry measured by Mermaid's layout engine.
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    configurable: true,
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    value: () => 100,
    configurable: true,
  });
});

describe("Mermaid rendering", () => {
  it("renders real diagrams with distinct IDs and recovers after a failed render", async () => {
    const code = "flowchart LR\nA[Start] --> B[Finish]";
    const [light, dark] = await Promise.all([
      renderMermaidDiagram(code, "light"),
      renderMermaidDiagram(code, "dark"),
    ]);
    const first = new DOMParser().parseFromString(light, "image/svg+xml");
    const second = new DOMParser().parseFromString(dark, "image/svg+xml");
    expect(first.documentElement.tagName).toBe("svg");
    expect(first.documentElement.textContent).toContain("Start");
    expect(first.documentElement.textContent).toContain("Finish");
    expect(first.documentElement.id).not.toBe(second.documentElement.id);
    await expect(renderMermaidDiagram("not a diagram", "light")).rejects.toThrow();
    expect(await renderMermaidDiagram("sequenceDiagram\nAlice->>Bob: Hello", "light")).toContain(
      "Hello",
    );
    expect(document.querySelectorAll('[id^="dt3-mermaid-"]')).toHaveLength(0);
  });
});
