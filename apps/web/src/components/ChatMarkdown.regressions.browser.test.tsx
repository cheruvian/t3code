import { AsyncResult } from "effect/reactivity";
import { filesystemEnvironment } from "../state/filesystem";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, render, type Screen } from "../../test/render";
import { useThreadFindHighlights } from "./chat/threadFindHighlights";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

import { MarkdownFindContext } from "./chat/markdownFindContext";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
const parsedSources = vi.hoisted(() => [] as string[]);
vi.mock(import("mdast-util-from-markdown"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    fromMarkdown: ((source: string, ...rest: never[]) => {
      parsedSources.push(String(source));
      return (actual.fromMarkdown as (...args: unknown[]) => unknown)(source, ...rest);
    }) as typeof actual.fromMarkdown,
  };
});

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const appearance = vi.hoisted(() => ({
  value: "light" as "light" | "dark",
  listeners: new Set<() => void>(),
}));
vi.mock(import("../hooks/useTheme"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    appearance.listeners.add(listener);
    return () => appearance.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useRenderedAppearance: () =>
      useSyncExternalStore(
        subscribe,
        () => appearance.value,
        () => appearance.value,
      ),
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";
import {
  canUseMarkdownFileShellActions,
  hasMarkdownFilePrimaryAction,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./chat/MarkdownFileLink.logic";

function codeButton(screen: Screen, label: string) {
  const button = [...screen.container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing code button: ${label}`);
  return button;
}

it.each(["chat", "file preview"])(
  "renders Mermaid in %s and exposes its source",
  async (surface) => {
    setup();
    const container = document.createElement("div");
    document.body.append(container);
    await using screen = await render(null, { container });
    const text = "```mermaid\nflowchart LR\nA[Start] --> B[Finish]\n```";
    try {
      await act(async () => {
        await screen.rerender(
          surface === "chat" ? (
            <ChatMarkdown cwd={undefined} text={text} />
          ) : (
            <FileMarkdownPreview
              workspaceMutationId={null}
              cwd="/workspace"
              relativePath="docs/diagram.md"
              text={text}
              threadRef={{
                environmentId: EnvironmentId.make("mermaid-env"),
                threadId: ThreadId.make("mermaid-thread"),
              }}
            />
          ),
        );
      });
      expect(container.querySelector('svg[aria-label="Diagram"]')).not.toBeNull();
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Show code"]')!.click();
        await getSyntaxHighlighterPromise("mermaid");
      });
      expect(container.querySelector('svg[aria-label="Diagram"]')).toBeNull();
      expect(container.textContent).toContain("flowchart LR");
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Show diagram"]')!.click();
      });
      expect(container.querySelector('svg[aria-label="Diagram"]')).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("shows a closed Mermaid fence while the reply continues and toggles its source", async () => {
  setup();
  const container = document.createElement("div");
  document.body.append(container);
  await using screen = await render(null, { container });
  const code = "flowchart LR\nA[Start] --> B[Finish]\n";
  try {
    await act(async () => {
      await screen.rerender(
        <ChatMarkdown cwd={undefined} text={`\`\`\`mermaid\n${code}`} isStreaming />,
      );
      await getSyntaxHighlighterPromise("mermaid");
    });
    expect(container.querySelector('svg[aria-label="Diagram"]')).toBeNull();
    await act(async () => {
      await screen.rerender(
        <ChatMarkdown
          cwd={undefined}
          text={`\`\`\`mermaid\n${code}\`\`\`\n\nMore text`}
          isStreaming
        />,
      );
    });
    expect(container.querySelector('svg[aria-label="Diagram"]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Show code"]')!.click();
    });
    expect(container.querySelector('svg[aria-label="Diagram"]')).toBeNull();
    expect(container.textContent).toContain("flowchart LR");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Show diagram"]')!.click();
    });
    expect(container.querySelector('svg[aria-label="Diagram"]')).not.toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("ChatMarkdown bare anchor placeholders", () => {
  it.each(["<A>", "<a>", "<a >", "<a/>", "<A/>", "<a />"])(
    "preserves unmatched %s without linking later blocks",
    (token) => {
      setup();
      const text = `- **"From ${token}"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.`;
      const document = new DOMParser().parseFromString(
        renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />),
        "text/html",
      );

      expect(document.querySelector("strong")?.textContent).toBe(`"From ${token}"`);
      expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
        "the link",
      ]);
      expect(document.querySelectorAll("li")).toHaveLength(2);
      expect(
        [...document.querySelectorAll("p")].map((paragraph) => paragraph.textContent),
      ).toContain("The deferred move continues on B.");
    },
  );

  it.each(["</a>  ", "<div>more</div>\n</a>"])(
    "preserves a paired anchor closing in the raw block %s",
    (closing) => {
      setup();
      const document = new DOMParser().parseFromString(
        renderToStaticMarkup(
          <ChatMarkdown cwd="/tmp/project" text={`See <a>label\n\n${closing}\n\nfinish`} />,
        ),
        "text/html",
      );
      expect(document.querySelector("p")?.textContent).toBe("See label");
    },
  );

  it("preserves a paired anchor after comment-looking raw text", () => {
    setup();
    const document = new DOMParser().parseFromString(
      renderToStaticMarkup(
        <ChatMarkdown cwd="/tmp/project" text="See <a>label<script><!-- </script> --></a>" />,
      ),
      "text/html",
    );
    expect(document.querySelector("p")?.textContent).toBe("See label -->");
  });

  it.each(["<!-- </a> -->", '<div title="</a>">more</div>', '<script>"</a>"</script>'])(
    "ignores apparent closing anchors inside %s",
    (html) => {
      setup();
      const document = new DOMParser().parseFromString(
        renderToStaticMarkup(
          <ChatMarkdown cwd="/tmp/project" text={`Before <A>.\n\n${html}\n\nAfter.`} />,
        ),
        "text/html",
      );
      expect(document.querySelector("p")?.textContent).toBe("Before <A>.");
      expect(document.querySelectorAll("a")).toHaveLength(0);
    },
  );

  it("preserves paired HTML anchors, details, markdown links, and inline code", () => {
    setup();
    const text =
      'Bare <a>label</a>, <a id="section"></a>, `<A>`, and [docs](https://example.com).\n\n<details><summary>More</summary>Details</details>';
    const document = new DOMParser().parseFromString(
      renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />),
      "text/html",
    );

    expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "label",
      "",
      "docs",
    ]);
    expect(document.querySelector("code")?.textContent).toBe("<A>");
    expect(document.querySelector("[data-markdown-details]")?.textContent).toContain("More");
  });
});

describe("ChatMarkdown context references", () => {
  it("renders text and image references through the chip screen, with readable fallback", async () => {
    setup();
    const text =
      "See [Terminal output](t3-context://v1/terminal/term-1) and ![Error image](t3-context://v1/image/img-1).";
    try {
      await using screen = await render(
        <ChatMarkdown
          cwd={undefined}
          text={text}
          renderContextReference={({ kind, label }) => (
            <button>
              {kind}: {label}
            </button>
          )}
        />,
      );
      expect(
        [...screen.container.querySelectorAll("button")].map((button) => button.textContent),
      ).toEqual(["terminal: Terminal output", "image: Error image"]);
      expect([...screen.container.querySelectorAll("img")]).toHaveLength(0);
      expect([...screen.container.querySelectorAll("a")]).toHaveLength(0);
      await act(async () => {
        await screen.rerender(<ChatMarkdown cwd={undefined} text={text} />);
      });
      expect(
        [...screen.container.querySelectorAll("span")].map((span) => span.textContent),
      ).toEqual(["Terminal output", "Error image"]);
      expect([...screen.container.querySelectorAll("img")]).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads formatted context labels through nested markup instead of the context id", async () => {
    setup();
    const seen: Array<string> = [];
    try {
      await using screen = await render(
        <ChatMarkdown
          cwd={undefined}
          text="See [**Bold** `code`](t3-context://v1/terminal/term-1)."
          renderContextReference={({ kind, label }) => {
            seen.push(`${kind}: ${label}`);
            return <button>{label}</button>;
          }}
        />,
      );
      expect(seen).toEqual(["terminal: Bold code"]);
      expect(screen.container.querySelector("button")?.textContent).toBe("Bold code");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    try {
      await using screen = await render(markdown("https://example.com"));
      expect(
        [...screen.container.querySelectorAll("img")].map((image) => image.getAttribute("src")),
      ).toEqual(["https://www.google.com/s2/favicons?domain=example.com&sz=32"]);
      for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
        await act(async () => {
          await screen.rerender(markdown(url));
        });
        expect([...screen.container.querySelectorAll("img")]).toHaveLength(0);
      }
      await act(async () => {
        await screen.rerender(markdown("https://example.com"));
      });
      expect([...screen.container.querySelectorAll("img")]).toHaveLength(1);
      await act(async () => {
        await screen.rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
      });
      expect([...screen.container.querySelectorAll("img")]).toHaveLength(0);
      expect(screen.container.querySelectorAll("svg")).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    try {
      await using screen = await render(message("```bash\necho hello\n```", true));
      const mounted = screen;
      expect(
        [...mounted.container.querySelectorAll("button")].some(
          (button) => button.getAttribute("aria-label") === "Run in terminal",
        ),
      ).toBe(false);

      await act(async () => {
        await mounted.rerender(message("```bash\necho hello\n```"));
      });
      await act(async () => {
        codeButton(mounted, "Run in terminal").click();
      });
      expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

      for (const text of [
        "~~~bash\necho tilde\n~~~",
        "> ```bash\n> echo quote\n> ```",
        "````bash\necho four\n````",
      ]) {
        await act(async () => {
          await mounted.rerender(message(text));
        });
        expect(codeButton(mounted, "Run in terminal")).toBeDefined();
      }

      for (const text of [
        "```bash\necho one\necho two\n```",
        "```typescript\necho hello\n```",
        "```bash\n\n```",
        "```bash\necho hello\n\n```",
        "```bash\necho hello\\\n```",
        "```bash\necho safe \u202e#\n```",
        "```bash\necho incomplete",
        "~~~bash\necho incomplete",
        "````bash\necho incomplete\n```",
        '<pre><code class="language-bash">echo html</code></pre>',
      ]) {
        await act(async () => {
          await mounted.rerender(message(text));
        });
        expect(
          [...mounted.container.querySelectorAll("button")].some(
            (button) => button.getAttribute("aria-label") === "Run in terminal",
          ),
        ).toBe(false);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retokenize completed lines when streaming finishes", async () => {
    setup();
    const highlighter = await getSyntaxHighlighterPromise("typescript");
    const highlight = vi.spyOn(highlighter, "codeToTokens");
    const text = "```typescript\nconst completed = 1;\nconst current = 2;";
    try {
      await using screen = await render(
        <ChatMarkdown cwd="/tmp/project" text={text} isStreaming />,
      );
      expect(highlight).toHaveBeenCalled();
      highlight.mockClear();
      await act(async () => {
        await screen.rerender(<ChatMarkdown cwd="/tmp/project" text={text + "\n```"} />);
      });
      expect(highlight.mock.calls.every(([code]) => !code.includes("const completed"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("recovers highlighting after a failed fence changes without resetting its controls", async () => {
    setup();
    const highlighter = await getSyntaxHighlighterPromise("text");
    const codeToHast = highlighter.codeToTokens.bind(highlighter);
    let fail = true;
    vi.spyOn(highlighter, "codeToTokens").mockImplementation((...args) => {
      if (fail) throw new Error("Temporary highlighter failure");
      return codeToHast(...args);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await using screen = await render(
        <ChatMarkdown cwd="/tmp/project" text={"```text\ninitial\n```"} isStreaming />,
      );
      const mounted = screen;
      const codeBlock = mounted.container.querySelector<HTMLElement>('[data-language="text"]')!;
      const initialWrap = codeBlock.getAttribute("data-wrap") === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      await act(async () => {
        wrap.click();
      });
      expect(mounted.container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(0);

      fail = false;
      await act(async () => {
        await mounted.rerender(
          <ChatMarkdown cwd="/tmp/project" text={"```text\nrecovered\n```"} isStreaming />,
        );
      });
      expect(mounted.container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(1);
      expect(mounted.container.querySelector<HTMLElement>('[data-language="text"]')!).toBe(
        codeBlock,
      );
      expect(codeBlock.getAttribute("data-wrap")).toBe(String(!initialWrap));
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("preserves code controls and details without highlighting an unchanged fence again", async () => {
    setup();
    const highlighter = await getSyntaxHighlighterPromise("text");
    const highlight = vi.spyOn(highlighter, "codeToTokens");
    const writeText = vi.fn(async (_text: string) => {});
    const tokenizer = vi.spyOn(highlighter, "createStreamTokenizer");
    using _clipboard = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);

    const text = [
      "```text",
      "First code block",
      "```",
      "",
      "<details><summary>More</summary>",
      "",
      "Details content",
      "",
      "</details>",
      "",
      "Streaming reply",
    ].join("\n");

    try {
      await using screen = await render(
        <ChatMarkdown cwd="/tmp/project" text={text} isStreaming />,
      );
      const mounted = screen;
      const codeBlock = mounted.container.querySelector<HTMLElement>('[data-language="text"]')!;
      const initialWrap = codeBlock.getAttribute("data-wrap") === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      const copy = codeButton(mounted, "Copy code");
      await act(async () => {
        wrap.click();
        copy.click();
      });

      const detailsButton = mounted.container.querySelector<HTMLButtonElement>(
        "[data-markdown-details-summary]",
      )!;
      await act(() => detailsButton.click());
      const details = mounted.container.querySelector<HTMLElement>("[data-markdown-details]")!;
      expect(details.getAttribute("data-markdown-details-open")).toBe("true");
      expect(writeText).toHaveBeenCalledWith("First code block\n");
      expect(highlight).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 10; index += 1) {
        await act(async () => {
          await mounted.rerender(
            <ChatMarkdown cwd="/tmp/project" text={`${text} ${index}`} isStreaming />,
          );
        });
      }

      expect(highlight).toHaveBeenCalledTimes(1);
      expect(mounted.container.querySelector<HTMLElement>('[data-language="text"]')!).toBe(
        codeBlock,
      );
      expect(codeBlock.getAttribute("data-wrap")).toBe(String(!initialWrap));
      expect(mounted.container.querySelector<HTMLElement>("[data-markdown-details]")!).toBe(
        details,
      );
      expect(details.getAttribute("data-markdown-details-open")).toBe("true");
      await act(async () => {
        await mounted.rerender(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text.replace("First code block", "Updated code block")}
            isStreaming
          />,
        );
      });
      const copyUpdated = codeButton(mounted, "Copied");
      await act(async () => {
        copyUpdated.click();
      });
      expect(writeText).toHaveBeenLastCalledWith("Updated code block\n");
      expect(highlight).toHaveBeenCalledTimes(1);
      expect(tokenizer).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    const message = (text: string) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
        }}
      />
    );

    try {
      await using screen = await render(message("- [ ] First\n- [ ] Second"));
      const mounted = screen;
      const originalInput = [...mounted.container.querySelectorAll("input")][1]!;
      await act(async () => {
        await mounted.rerender(message("- [ ] A longer first task\n- [ ] Second"));
      });

      const input = [...mounted.container.querySelectorAll("input")][1]!;
      await act(() => input.click());
      await mounted.rerender(message(editedText!));

      expect(input).toBe(originalInput);
      expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
      expect([...mounted.container.querySelectorAll("input")][1]!.checked).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions for local environments", () => {
    setup();
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", true)).toBe(true);
  });

  it("hides shell actions until the environment mode is resolved", () => {
    setup();
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", false)).toBe(false);
  });

  it("hides editor and file manager actions for remote environments", () => {
    setup();
    expect(canUseMarkdownFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
  });

  it("hides shell actions when no environment owns the markdown", () => {
    setup();
    expect(canUseMarkdownFileShellActions(null, "local-exec", true)).toBe(false);
  });
});

describe("hasMarkdownFilePrimaryAction", () => {
  it("keeps the chip interactive when an editor, browser, or panel can open it", () => {
    setup();
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: true,
        canOpenInBrowser: false,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: false,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });

  it("removes the link affordance when no primary action can open the file", () => {
    setup();
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: false,
        canOpenInPanel: false,
      }),
    ).toBe(false);
  });
});

describe("ChatMarkdown skill chips", () => {
  it("updates digit-leading skill labels when discovered skills change", async () => {
    setup();
    const text = "Use $2spec with a $20k budget.";
    try {
      await using screen = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);
      const mounted = screen;
      const labels = (label: string) =>
        [...mounted.container.querySelectorAll("span")].filter(
          (node) => node.textContent === label,
        );
      expect(labels("2Spec")).toHaveLength(0);

      await act(async () => {
        await mounted.rerender(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text}
            skills={[
              { name: "2spec", displayName: "2Spec", path: "/skills/2spec", enabled: true },
              { name: "20k", displayName: "MoneySkill", path: "/skills/20k", enabled: true },
            ]}
          />,
        );
      });
      expect(labels("2Spec")).toHaveLength(1);
      expect(labels("MoneySkill")).toHaveLength(0);

      await act(async () => {
        await mounted.rerender(<ChatMarkdown cwd="/tmp/project" text={text} skills={[]} />);
      });
      expect(labels("2Spec")).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown file option chips", () => {
  it("keeps the fallback button text selectable", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text="[Source](/tmp/project/src/main.ts)" />,
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("select-text");
  });

  it.each([true, false])(
    "renders Codex file citations as file chips with parseRawHtml=%s",
    (parseRawHtml) => {
      setup();
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="/tmp/project"
          text={
            'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx" purpose="output"}.'
          }
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).not.toContain("codex-file-citation");
      expect(html).toContain("chat-markdown-file-link");
      expect(html).toContain(
        'data-markdown-copy="[report.xlsx](/tmp/project/outputs/report.xlsx)"',
      );
      expect(html).toContain("report.xlsx");
    },
  );

  it("leaves an unfinished streaming citation visible until it is complete", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"'}
        isStreaming
      />,
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("leaves malformed and similarly named file directives literal", () => {
    setup();
    for (const text of [
      ':codex-file-citation{purpose="output"}',
      ':codex-file-citation-extra{path="/tmp/project/outputs/report.xlsx"}',
    ]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(html).toContain(text.replaceAll('"', "&quot;"));
      expect(html).not.toContain("chat-markdown-file-link");
    }
  });

  it("preserves Codex file citation examples inside code", () => {
    setup();
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`Example: \`${directive}\`\n\n\`\`\`text\n${directive}\n\`\`\``}
      />,
    );

    expect(html.match(/:codex-file-citation/g)).toHaveLength(2);
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("preserves escaped Codex file citations as literal text", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Example: \\:codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("does not create a nested link for citations inside link text", () => {
    setup();
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text={`[See ${directive}](https://example.com)`} />,
    );
    const renderedText = html.replace(/<[^>]+>/g, "");

    expect(renderedText).toContain("codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("renders file citations created by over-indented list recovery", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'-       Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );

    expect(html).not.toContain("<pre>");
    expect(html).toContain("Created ");
    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain("report.xlsx");
  });

  it("disambiguates Codex citations with the same basename", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Changed :codex-file-citation{path="/tmp/project/src/index.ts"} and :codex-file-citation{path="/tmp/project/test/index.ts"}.'
        }
      />,
    );

    expect(html).toContain("index.ts · project/src");
    expect(html).toContain("index.ts · project/test");
  });

  it("preserves rejected citations created by over-indented list recovery", () => {
    setup();
    const malformedHtml = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Leading text before list.\n\n-       Bad :codex-file-citation{purpose="output"}'}
      />,
    );
    const nestedLinkHtml = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Leading text before list.\n\n-       [Bad :codex-file-citation{path="/tmp/project/report.xlsx"}](https://example.com)'
        }
      />,
    );
    const nestedLinkText = nestedLinkHtml.replace(/<[^>]+>/g, "");

    expect(malformedHtml).toContain(
      "<li>Bad :codex-file-citation{purpose=&quot;output&quot;}</li>",
    );
    expect(nestedLinkText).toContain(
      "Bad :codex-file-citation{path=&quot;/tmp/project/report.xlsx&quot;}",
    );
  });
});

describe("ChatMarkdown Codex follow-up suggestions", () => {
  it.each([true, false])("renders the label with parseRawHtml=%s", (parseRawHtml) => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Done.\n\n- :codex-followup[Prepare print version]{prompt="Prepare the document for printing."}'
        }
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain("Prepare print version");
    expect(html).not.toContain("codex-followup");
    expect(html).not.toContain("Prepare the document for printing.");
  });

  it("keeps the label of a malformed follow-up created by over-indented list recovery", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text="-       Next :codex-followup[Prepare print version]"
      />,
    );

    expect(html).toContain("<li>Next :codex-followup[Prepare print version]</li>");
  });
});

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

describe("ChatMarkdown artifact-template cards", () => {
  it.each([true, false])("renders the Codex result card with parseRawHtml=%s", (parseRawHtml) => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={ARTIFACT_TEMPLATE_DIRECTIVE}
        parseRawHtml={parseRawHtml}
        onUseArtifactTemplate={() => undefined}
      />,
    );

    expect(html).not.toContain("::artifact-template");
    expect(html).toContain("data-chat-markdown-artifact-template");
    expect(html).toContain('data-artifact-kind="document"');
    expect(html).toContain('data-markdown-copy="Hello World (Document template)\n\n"');
    expect(html).toContain('data-skill-name="artifact-template-hello-world"');
    expect(html).toContain("Hello World");
    expect(html).toContain("Document template");
    expect(html).toContain("Use template");
    expect(html).not.toContain("<p><div");
  });

  it("renders a passive card outside a composer-backed timeline", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text={ARTIFACT_TEMPLATE_DIRECTIVE} />,
    );

    expect(html).toContain("data-chat-markdown-artifact-template");
    expect(html).not.toContain("Use template");
  });

  it("leaves malformed and unfinished artifact-template directives literal", () => {
    setup();
    const malformed =
      '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';
    const unfinished = ARTIFACT_TEMPLATE_DIRECTIVE.slice(0, -1);

    for (const text of [malformed, unfinished]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);
      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("data-chat-markdown-artifact-template");
    }
  });

  it("leaves escaped and similarly named artifact-template directives literal", () => {
    setup();
    for (const text of [
      `\\${ARTIFACT_TEMPLATE_DIRECTIVE}`,
      ARTIFACT_TEMPLATE_DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
    ]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("data-chat-markdown-artifact-template");
    }
  });

  it("preserves artifact-template examples inside code", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`\`${ARTIFACT_TEMPLATE_DIRECTIVE}\`\n\n\`\`\`text\n${ARTIFACT_TEMPLATE_DIRECTIVE}\n\`\`\``}
      />,
    );

    expect(html.match(/::artifact-template/g)).toHaveLength(2);
    expect(html).not.toContain("data-chat-markdown-artifact-template");
  });
});

describe("ChatMarkdown heading levels", () => {
  it("exposes headings below the host heading without changing their tags", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"# Top\n\n## Section\n\n###### Fine print"}
        headingLevelOffset={3}
      />,
    );

    expect(html).toContain('<h1 id="user-content-top" dir="ltr" aria-level="4">Top</h1>');
    expect(html).toContain('<h2 id="user-content-section" dir="ltr" aria-level="5">Section</h2>');
    expect(html).toContain(
      '<h6 id="user-content-fine-print" dir="ltr" aria-level="6">Fine print</h6>',
    );
  });

  it("leaves heading levels alone when the markdown is not nested", () => {
    setup();
    const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text="# Top" />);

    expect(html).toContain('<h1 id="user-content-top" dir="ltr">Top</h1>');
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  it("uses the browser when it is the only available primary action", () => {
    setup();
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(true);
  });

  it("preserves the normal editor and panel defaults for HTML files", () => {
    setup();
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(false);
  });

  it("continues to open PDF files in the browser by default", () => {
    setup();
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");

  it.each([true, false])("preserves drive paths with parseRawHtml=%s", (parseRawHtml) => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[Open](C:/Users/shawn/project/src/main.ts)"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])("normalizes backslashes with parseRawHtml=%s", (parseRawHtml) => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={String.raw`[Open](C:\Users\shawn\project\src\main.ts)`}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])(
    "keeps backslashes CommonMark would read as escapes with parseRawHtml=%s",
    (parseRawHtml) => {
      setup();
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[settings](C:\Users\shawn\.claude\settings.json)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).toContain('href="C:/Users/shawn/.claude/settings.json"');
    },
  );

  it.each([true, false])(
    "distinguishes same-named backslash paths with parseRawHtml=%s",
    (parseRawHtml) => {
      setup();
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[Source](C:\Users\shawn\project\src\index.ts) and [Test](C:\Users\shawn\project\test\index.ts)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).toContain("index.ts · project/src");
      expect(html).toContain("index.ts · project/test");
    },
  );

  it.each([true, false])(
    "keeps inline code unlinked until the host verifies it with parseRawHtml=%s",
    (parseRawHtml) => {
      setup();
      const path = String.raw`C:\Users\shawn\project\src\main.ts`;
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={`[Source](${path}) and \`${path}\``}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(
        new DOMParser()
          .parseFromString(html, "text/html")
          .querySelectorAll(".chat-markdown-file-link"),
      ).toHaveLength(1);
      expect(html).not.toContain("main.ts ·");
    },
  );

  it.each([true, false])("preserves reference links with parseRawHtml=%s", (parseRawHtml) => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={"[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])("still rejects unsafe schemes with parseRawHtml=%s", (parseRawHtml) => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[unsafe](javascript:alert(1)) and [unknown](d:alert(1))"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("d:alert");
    expect(html).not.toContain("chat-markdown-file-link");
  });
});

it("opens a disclosure only when find selects a match inside it", async () => {
  setup();
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { highlights, escape: (value: string) => value });
  const container = document.createElement("div");
  document.body.append(container);
  await using screen = await render(null, { container });
  const openStates = () =>
    [...container.querySelectorAll("[data-markdown-details-open]")].map((node) =>
      node.getAttribute("data-markdown-details-open"),
    );
  function Probe({
    activeOccurrence,
    searching = true,
  }: {
    activeOccurrence: number;
    searching?: boolean;
  }) {
    useThreadFindHighlights({
      container,
      query: searching ? "needle" : "",
      activeRowId: "row",
      activeOccurrence,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={searching}>
            <ChatMarkdown
              cwd={undefined}
              text={[
                "Visible needle.",
                "<details><summary>Unrelated</summary><p>nothing here</p></details>",
                "<details><summary>Outer</summary><details><summary>Inner</summary><p>needle</p></details></details>",
              ].join("\n\n")}
            />
          </MarkdownFindContext>
        </div>
      </div>
    );
  }
  try {
    await screen.rerender(<Probe activeOccurrence={0} searching={false} />);
    expect(container.textContent).not.toContain("nothing here");
    await screen.rerender(<Probe activeOccurrence={0} />);
    await vi.waitFor(() => expect(openStates()).toEqual(["false", "false", "false"]));
    expect(container.textContent).toContain("nothing here");
    expect(
      [...(highlights.get("t3-thread-find-active") ?? [])].map((range) => range.toString()),
    ).toEqual(["needle"]);
    expect(highlights.get("t3-thread-find")?.size).toBe(0);

    await screen.rerender(<Probe activeOccurrence={1} />);
    await vi.waitFor(() => expect(openStates()).toEqual(["false", "true", "true"]));
    await vi.waitFor(() => expect(highlights.get("t3-thread-find-active")?.size).toBe(1));
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps Mermaid diagrams rendered until find selects a match in their source", async () => {
  setup();
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { highlights, escape: (value: string) => value });
  const container = document.createElement("div");
  document.body.append(container);
  await using screen = await render(null, { container });
  const diagram = "```mermaid\ngraph TD; Alpha-->Beta\n```";
  function Probe({ query }: { query: string }) {
    useThreadFindHighlights({
      container,
      query,
      activeRowId: "row",
      activeOccurrence: 0,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={true}>
            <ChatMarkdown cwd={undefined} text={`Needle first.\n\n${diagram}\n\n${diagram}`} />
          </MarkdownFindContext>
        </div>
      </div>
    );
  }
  const diagrams = () => container.querySelectorAll('svg[aria-label="Diagram"]').length;
  try {
    await screen.rerender(<Probe query="Needle" />);
    await vi.waitFor(() => expect(diagrams()).toBe(2));
    await screen.rerender(<Probe query="Alpha" />);
    await vi.waitFor(() => expect(diagrams()).toBe(1));
    await vi.waitFor(() =>
      expect(
        [...(highlights.get("t3-thread-find-active") ?? [])].map((range) => range.toString()),
      ).toEqual(["Alpha"]),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  {
    text: "```mermaid\ngraph TD; SearchSourceAlpha-->B\n```",
    query: "SearchSourceAlpha",
    count: 1,
  },
  {
    text: "★ Insight ─────\nfirst line\nsecond line",
    query: "first line second",
    count: 0,
    lineBreaks: true,
  },
  { text: '```ts title="src/needle.ts"\nconst a = 1;\n```', query: "needle", count: 0 },
  { text: "```weirdlang\nconst a = 1;\n```", query: "weirdlang", count: 0 },
  { text: "Use $test-t3-app now", query: "T3 App Testing", count: 1 },
  { text: "`/tmp/file.ts:42`", query: "file.ts · L42", count: 1, user: true, lineBreaks: true },
  { text: "> [!NOTE]\n> Searchable alert", query: "Searchable alert", count: 1 },
  {
    text: "<details><summary>Folded</summary><p>Hidden needle</p></details>",
    query: "Hidden needle",
    count: 1,
  },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Hello World", count: 1, acceptsTemplate: true },
  {
    text: ARTIFACT_TEMPLATE_DIRECTIVE,
    query: "Document template",
    count: 1,
    acceptsTemplate: true,
  },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "World Document", count: 0, acceptsTemplate: true },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Use template", count: 0, acceptsTemplate: true },
])(
  "highlights the indexed occurrences of $query in $text",
  async ({ text, query, count, lineBreaks, user, acceptsTemplate }) => {
    setup();
    const skills = [{ name: "test-t3-app", displayName: "T3 App Testing" }];
    const highlights = new Map<string, Set<Range>>();
    vi.stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      },
    );
    vi.stubGlobal("CSS", { highlights, escape: (value: string) => value });
    const container = document.createElement("div");
    document.body.append(container);
    await using screen = await render(null, { container });
    function Probe() {
      useThreadFindHighlights({
        container,
        query,
        activeRowId: "row",
        activeOccurrence: 0,
        onActiveRange: () => {},
      });
      return (
        <div data-timeline-row-id="row">
          <div data-thread-find-text>
            <MarkdownFindContext value={true}>
              <ChatMarkdown
                text={text}
                cwd={user ? "/tmp" : undefined}
                threadRef={
                  user
                    ? {
                        environmentId: EnvironmentId.make("find-env"),
                        threadId: ThreadId.make("find-thread"),
                      }
                    : undefined
                }
                skills={skills.map((skill) => ({
                  ...skill,
                  path: `/skills/${skill.name}`,
                  enabled: true,
                }))}
                lineBreaks={lineBreaks ?? false}
                parseRawHtml={!user}
                onUseArtifactTemplate={acceptsTemplate ? () => undefined : undefined}
              />
            </MarkdownFindContext>
          </div>
        </div>
      );
    }
    try {
      await screen.rerender(<Probe />);
      await vi.waitFor(() =>
        expect([...highlights.values()].flatMap((value) => [...value])).toHaveLength(count),
      );
      const ranges = [...highlights.values()].flatMap((value) => [...value]);
      expect(ranges.map((range) => range.toString())).toEqual(
        Array.from({ length: count }, () => query),
      );
      const segments =
        searchableMessageSegments(
          { role: user ? "user" : "assistant", text, streaming: false },
          undefined,
          skills,
        ) ?? [];
      expect(
        segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
      ).toBe(count);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

describe("ChatMarkdown heading ids", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", () => {
    setup();
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        parseRawHtml
        text={
          '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install'
        }
      />,
    );
    const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ChatMarkdown in-page links", () => {
  it.each([true, false])(
    "scrolls a table-of-contents link to its heading without touching the URL (parseRawHtml=%s)",
    async (parseRawHtml) => {
      setup();

      const container = document.createElement("div");
      document.body.append(container);
      await using screen = await render(null, { container });
      window.history.replaceState(null, "", "/#/env/thread");
      const scrollIntoView = vi.fn();
      HTMLElement.prototype.scrollIntoView = scrollIntoView;

      await act(async () => {
        await screen.rerender(
          <ChatMarkdown
            cwd="/tmp/project"
            parseRawHtml={parseRawHtml}
            text={
              "- [Operating model](#1-operating-model)\n- [Missing](#nowhere)\n\n## 1. Operating model\n\n## 1. Operating model"
            }
          />,
        );
      });
      const headings = [...container.querySelectorAll("h2")];
      expect(headings.map((heading) => heading.id)).toEqual([
        "user-content-1-operating-model",
        "user-content-1-operating-model-1",
      ]);

      const [tocLink, missingLink] = [...container.querySelectorAll("a")];
      const click = () => new MouseEvent("click", { bubbles: true, cancelable: true });
      const tocClick = click();
      tocLink!.dispatchEvent(tocClick);
      expect(tocClick.defaultPrevented).toBe(true);
      expect(scrollIntoView.mock.contexts).toEqual([headings[0]]);

      const missingClick = click();
      missingLink!.dispatchEvent(missingClick);
      expect(missingClick.defaultPrevented).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(window.location.hash).toBe("#/env/thread");
    },
  );
});

function setup() {
  appearance.value = "dark";
  parsedSources.length = 0;
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch
    .mockReset()
    .mockImplementation(async (request: { environmentId?: string; input?: { paths?: string[] } }) =>
      AsyncResult.success(
        request.environmentId === "find-env"
          ? (request.input?.paths ?? [])
              .filter((path) => path === "/tmp/file.ts")
              .map((path) => ({ path, absolutePath: path, relativePath: "file.ts" }))
          : [],
      ),
    );
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}
