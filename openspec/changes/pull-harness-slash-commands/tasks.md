## 1. Confirm on-disk conventions

- [ ] 1.1 Confirm Codex's local reusable-prompt directory name, file extension, and any frontmatter fields (check Codex CLI docs/source or an installed `~/.codex/` tree) and adjust the design's assumed path if it differs
- [ ] 1.2 Confirm Cursor's local command directory name, file extension, and any frontmatter fields and adjust the design's assumed path if it differs

## 2. Codex slash command discovery

- [ ] 2.1 Add `apps/server/src/provider/Drivers/CodexSlashCommands.ts` with a `discoverCodexSlashCommands(homePath, workspaceCwd)` Effect that scans user-scope and project-scope prompt directories and returns `ServerProviderSlashCommand[]`, project scope overriding user scope by name
- [ ] 2.2 Parse each command file (frontmatter + filename fallback) per spec `provider-slash-commands` requirement "Parse command file into slash command metadata", skipping files with no usable name
- [ ] 2.3 Wire `discoverCodexSlashCommands` into `CodexDriver.ts`'s snapshot construction, passing `homePath` via the existing `resolveCodexHomeLayout` result
- [ ] 2.4 Add `CodexSlashCommands.test.ts` covering: project-scope only, user-scope only, both scopes with collision (project wins), missing directories, malformed file skipped

## 3. Cursor slash command discovery

- [ ] 3.1 Add a minimal Cursor home-path resolver (mirroring `ClaudeHome.ts::resolveClaudeHomePath`) if none exists, scoped to locating `~/.cursor`
- [ ] 3.2 Add `apps/server/src/provider/Drivers/CursorSlashCommands.ts` with a `discoverCursorSlashCommands(homePath, workspaceCwd)` Effect following the same scan/parse/merge shape as Codex's
- [ ] 3.3 Wire `discoverCursorSlashCommands` into `CursorDriver.ts`'s snapshot construction
- [ ] 3.4 Add `CursorSlashCommands.test.ts` mirroring the Codex test coverage

## 4. Verification

- [ ] 4.1 Run the full server test suite and confirm no regression to existing Claude `slashCommands` behavior (Claude's discovery path is untouched)
- [ ] 4.2 Manually verify (or via test) that `providerSnapshot.ts` output includes discovered Codex/Cursor commands and that web (`ComposerCommandMenu.tsx`) and mobile (`ThreadComposer.tsx`) consumers render them without changes, since they already iterate `slashCommands` generically
