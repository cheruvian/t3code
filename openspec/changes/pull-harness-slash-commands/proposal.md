## Why

T3 Code's provider snapshot exposes a `slashCommands` list per provider that drives the composer command menu (web) and the `$`-command picker (mobile). Today only the Claude provider populates it, and only via the Agent SDK init handshake (`ClaudeProvider.ts`) — there is no filesystem discovery of commands defined in a provider's own local harness config (e.g. `.claude/commands/`, `~/.codex/prompts/`, `.cursor/commands/`). Codex, Cursor, Grok, and OpenCode drivers report an empty `slashCommands` array even when the user has commands configured for that harness on disk, so users lose their custom commands when working through those providers in T3 Code.

## What Changes

- Add filesystem-based slash command discovery for Codex (`~/.codex/prompts/*.md` or equivalent local config location), Cursor (`.cursor/commands/*.md`), and any other driver with a known local command directory convention, mirroring the existing `discoverClaudeSkills` pattern in `ClaudeSkills.ts` (user-scope + project-scope directories, project wins on name collision).
- Parse each discovered command file's frontmatter/body into a `ServerProviderSlashCommand` (`name`, optional `description`, optional `input.hint`), consistent with the shape already produced for Claude.
- Wire discovered commands into each driver's provider snapshot construction so `slashCommands` is populated for every provider that has local commands, not just Claude.
- Leave the existing Claude Agent-SDK-sourced slash command path untouched — this change only fills the gap for drivers that currently return `[]`.

## Capabilities

### New Capabilities
- `provider-slash-commands`: discovery of a provider's local slash/prompt command files from its harness config directories and their inclusion in the provider snapshot consumed by web and mobile composers.

### Modified Capabilities
(none — no existing spec covers this behavior yet)

## Impact

- `apps/server/src/provider/Drivers/`: new discovery modules (e.g. `CodexSlashCommands.ts`, `CursorSlashCommands.ts`) plus wiring into `CodexDriver.ts`, `CursorDriver.ts`, and other drivers as applicable.
- `apps/server/src/provider/providerSnapshot.ts`: no shape change expected (already accepts `slashCommands`), but callers per-driver need to pass discovered commands.
- `packages/contracts/src/server.ts`: `ServerProviderSlashCommand` type reused as-is; no schema change expected.
- Downstream consumers unaffected in shape: `apps/web/src/components/chat/ComposerCommandMenu.tsx`, `composerSlashCommandSearch.ts`, `apps/mobile/src/features/threads/ThreadComposer.tsx` — they already iterate `slashCommands` generically.
- New tests mirroring `ClaudeSkills.test.ts` for each new discovery module.
