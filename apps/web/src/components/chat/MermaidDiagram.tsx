import { useEffect, useState, type ReactNode } from "react";

import { renderMermaidDiagram } from "../../lib/mermaidRendering";

export function MermaidDiagram({
  code,
  theme,
  pending,
  children,
}: {
  code: string;
  theme: "light" | "dark";
  pending: boolean;
  children: ReactNode;
}) {
  const [result, setResult] = useState<{
    code: string;
    theme: string;
    svg: string | null;
  } | null>(null);
  useEffect(() => {
    if (pending) return;
    let active = true;
    void renderMermaidDiagram(code, theme).then(
      (svg) => {
        if (active) setResult({ code, theme, svg });
      },
      () => {
        if (active) setResult({ code, theme, svg: null });
      },
    );
    return () => {
      active = false;
    };
  }, [code, theme, pending]);

  if (pending || result?.code !== code || result.theme !== theme) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground" role="status">
        {pending ? "Waiting for diagram…" : "Rendering diagram…"}
      </div>
    );
  }
  if (result.svg === null) {
    return (
      <>
        <p className="px-3 pt-3 text-xs text-muted-foreground" role="status">
          Could not render this Mermaid diagram. Showing source code.
        </p>
        {children}
      </>
    );
  }
  return (
    <div
      role="img"
      aria-label="Mermaid diagram"
      className="overflow-x-auto p-3 [&_svg]:mx-auto [&_svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}
