import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

import { mermaidDocument } from "../../modules/t3-markdown-text/src/mermaidDocument";

describe("mobile Mermaid document", () => {
  it("preserves authored code without letting it terminate the script, and reports rendered height", async () => {
    const code = 'flowchart LR\nA["</script><script>alert(1)</script>"]';
    const html = mermaidDocument("", code, "dark");
    expect(html.match(/<script>/g)).toHaveLength(2);
    const render = vi.fn(async () => ({ svg: "<svg>Diagram</svg>" }));
    const postMessage = vi.fn();
    const target = { innerHTML: "" };
    await NodeVM.runInNewContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1]![1]!, {
      mermaid: { initialize() {}, render },
      document: {
        getElementById: () => target,
        body: { getBoundingClientRect: () => ({ height: 123.4 }) },
      },
      window: { ReactNativeWebView: { postMessage } },
    });
    expect(render).toHaveBeenCalledWith("t3-mermaid", code);
    expect(target.innerHTML).toBe("<svg>Diagram</svg>");
    expect(JSON.parse(postMessage.mock.calls[0]![0] as string)).toEqual({ height: 124 });
  });

  it("reports parsing errors so the native view can show source code", async () => {
    const html = mermaidDocument("", "invalid", "light");
    const postMessage = vi.fn();
    await NodeVM.runInNewContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1]![1]!, {
      mermaid: {
        initialize() {},
        render: async () => {
          throw new Error("Syntax error");
        },
      },
      window: { ReactNativeWebView: { postMessage } },
    });
    expect(JSON.parse(postMessage.mock.calls[0]![0] as string)).toEqual({ error: true });
  });
});
