let nextDiagramId = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

/** Serialize initialization and rendering because Mermaid's configuration is global. */
export function renderMermaidDiagram(code: string, theme: "light" | "dark") {
  const result = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
    });
    const { svg } = await mermaid.render(`t3-mermaid-${nextDiagramId++}`, code);
    return svg;
  });
  renderQueue = result.catch(() => undefined);
  return result;
}
