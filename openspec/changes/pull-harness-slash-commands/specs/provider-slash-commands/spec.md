## Purpose

Discovers slash/prompt command files a provider's own local coding harness config directory defines, so those commands appear in T3 Code's composer command menus alongside provider-reported commands.

## ADDED Requirements

### Requirement: Discover local slash commands from provider harness config directories
For each provider driver with a known local command-file convention (e.g. Codex `~/.codex/prompts/`, Cursor `.cursor/commands/`), the system SHALL scan that provider's user-scope and project-scope local config directories for command files and include the ones found in that provider's `slashCommands` list.

#### Scenario: Commands found in project-scope directory
- **WHEN** the current workspace contains command files in the provider's project-scope command directory (e.g. `.cursor/commands/*.md`)
- **THEN** each valid command file is included in that provider's `slashCommands` list

#### Scenario: Commands found in user-scope directory only
- **WHEN** no project-scope command directory exists but the provider's user-scope config directory contains command files
- **THEN** each valid command file is included in that provider's `slashCommands` list

#### Scenario: No local command directories exist
- **WHEN** neither the provider's user-scope nor project-scope command directory exists on disk
- **THEN** that provider's `slashCommands` list contains no filesystem-discovered entries and discovery does not error

### Requirement: Project-scope commands take precedence on name collision
When a command with the same name is defined in both the user-scope and project-scope directories for a provider, the system SHALL use the project-scope definition.

#### Scenario: Same command name in both scopes
- **WHEN** a command named `review` exists in both the user-scope and project-scope command directories for a provider
- **THEN** the resulting `slashCommands` list contains one entry named `review` whose description/hint come from the project-scope file

### Requirement: Parse command file into slash command metadata
The system SHALL parse each discovered command file into a name, an optional description, and an optional argument hint, tolerating files that lack optional fields.

#### Scenario: Command file with full metadata
- **WHEN** a command file defines a name, a description, and an argument hint
- **THEN** the resulting slash command entry includes all three fields

#### Scenario: Command file missing optional fields
- **WHEN** a command file defines only a name
- **THEN** the resulting slash command entry includes the name with no description or input hint, and discovery does not error

#### Scenario: Command file missing a name
- **WHEN** a command file has no identifiable name (no frontmatter name and no usable filename)
- **THEN** that file is skipped and does not appear in `slashCommands`

### Requirement: Discovery does not affect providers with SDK-reported commands
For a provider that already reports slash commands via a live handshake with its own SDK/CLI (e.g. Claude via the Agent SDK), the system SHALL NOT replace or duplicate those SDK-reported commands with filesystem-discovered ones from the same provider.

#### Scenario: Claude provider unaffected
- **WHEN** the Claude provider snapshot is built
- **THEN** its `slashCommands` list continues to come solely from the Agent SDK init handshake, unchanged by this capability
