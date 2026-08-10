## Why

The file browser's preview panel (`FilePreviewPanel.tsx`) already renders markdown via `ChatMarkdown` (a component built for chat messages) with a raw/rendered toggle, but it has no dedicated read-only markdown viewer and no real review surface — `LocalCommentAnnotation` is a local, non-persisted stand-in. The `remarks` project (`~/workplace/remarks`) already provides a layered, purpose-built annotatable markdown renderer (`@remarks/renderer`, `@remarks/anchor`, `@remarks/review`, `@remarks/store`) intended for exactly this kind of reader/review surface. Adopting it gives the file browser a proper read-only markdown view and a path to real anchored commenting and sign-off review, instead of continuing to stretch a chat-message renderer into a document viewer.

## What Changes

- Add a dedicated read-only markdown viewer for `.md`/`.mdx` files in the file browser, replacing `ChatMarkdown` reuse in `FilePreviewPanel.tsx` with `@remarks/renderer` (via `@remarks/anchor`).
- Preserve the existing raw-source/rendered toggle (`isMarkdownPreviewFile`, `filePreviewMode.ts`) but back the rendered mode with the new viewer.
- Introduce a review surface on markdown files backed by `@remarks/annotations` (`@remarks/anchor` + `@remarks/store-local` + `@remarks/review`), replacing `LocalCommentAnnotation` for markdown files: readers can leave anchored comments and see per-section reviewed/changed/unreviewed status derived from content hashes.
- Take `@remarks/*` packages as workspace/path dependencies from `~/workplace/remarks` (unpublished; consumed via local path or `workspace:*`-style reference since they are not yet published to a registry).
- Markdown task-checkbox toggling (`setMarkdownTaskChecked`) continues to operate on raw source only; the rendered view remains read-only (no inline editing).

## Capabilities

### New Capabilities
- `markdown-file-preview`: Read-only rendering of markdown files in the file browser's preview panel, with a raw-source/rendered toggle.
- `markdown-review-surface`: Anchored commenting and reviewed/changed/unreviewed sign-off status for markdown files in the file browser, backed by the `remarks` review model.

### Modified Capabilities
(none — no existing spec covers file preview behavior today)

## Impact

- `apps/web/src/components/files/FilePreviewPanel.tsx`: swap `ChatMarkdown` for a `@remarks/renderer`-based viewer for markdown files; wire `@remarks/annotations`/`@remarks/review` in place of `LocalCommentAnnotation` for markdown files.
- `apps/web/src/components/files/filePreviewMode.ts`, `LocalCommentAnnotation.tsx`: behavior scoped/adjusted for markdown files specifically.
- New dependency: `@remarks/anchor`, `@remarks/renderer`, `@remarks/annotations`, `@remarks/review`, `@remarks/store-local` from `~/workplace/remarks` (currently unpublished — requires local path or workspace linkage until published).
- No change to non-markdown file preview (code/image handling via `@pierre/diffs` and `isWorkspaceImagePreviewPath` is unaffected).
