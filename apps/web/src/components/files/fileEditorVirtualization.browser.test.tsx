import { DEFAULT_THEMES, preloadHighlighter, VirtualizedFile } from "@pierre/diffs";
import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

it("retains measured wrapped lines before edits across layout checkpoints and undo", async () => {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
  const lines = Array.from({ length: 6001 }, (_, index) =>
    index < 12 ? `// ${"wrapped content ".repeat(24)}` : `const line${index} = ${index};`,
  );
  let editor: Editor<"file" | "file-diff", undefined, undefined> | undefined;
  let file: VirtualizedFile | undefined;
  const createEditor: EditorFactory<undefined, undefined> = (...args) =>
    (editor = new Editor(...args));
  await using _screen = await render(
    <div style={{ width: 283, height: 320, display: "flex", flexDirection: "column" }}>
      <EditProvider createEditor={createEditor}>
        <Virtualizer style={{ minHeight: 0, flex: 1, overflow: "auto" }}>
          <File
            file={{ name: "wrapped.ts", contents: lines.join("\n") }}
            edit
            options={{
              overflow: "wrap",
              disableFileHeader: true,
              onPostRender: (_node, instance) => {
                if (instance instanceof VirtualizedFile) file = instance;
              },
            }}
          />
        </Virtualizer>
      </EditProvider>
    </div>,
    // This fixture exercises the native editor and virtualizer without app routing.
    { router: false },
  );
  await vi.waitFor(() => expect(file?.getLinePosition(1)?.height).toBeGreaterThan(40));
  const before = file!.getLinePosition(5000);
  expect(before).toBeDefined();
  const position = { line: 6000, character: lines[6000]!.length };
  await act(async () =>
    editor!.applyEdits([{ range: { start: position, end: position }, newText: "\n" }]),
  );
  expect(editor!.getText()).toBe(`${lines.join("\n")}\n`);
  expect(file!.getLinePosition(5000)).toEqual(before);
  await act(async () => editor!.undo());
  expect(editor!.getText()).toBe(lines.join("\n"));
  expect(file!.getLinePosition(5000)).toEqual(before);
  await act(async () => editor!.redo());
  expect(file!.getLinePosition(5000)).toEqual(before);
});
