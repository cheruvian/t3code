## Purpose

Lets a user open a markdown file in the file browser and read it as formatted output rather than raw syntax, while still allowing them to inspect the raw source.

## ADDED Requirements

### Requirement: Rendered markdown view
The system SHALL render `.md` and `.mdx` files selected in the file browser as formatted (HTML-equivalent) output by default, instead of raw text.

#### Scenario: Opening a markdown file
- **WHEN** a user selects a `.md` or `.mdx` file in the file browser
- **THEN** the preview panel displays the file's content rendered as formatted markdown (headings, lists, links, code blocks, tables)

### Requirement: Toggle between rendered and raw source
The system SHALL let the user switch the markdown preview between rendered output and raw source text for the currently open file.

#### Scenario: Switching to raw source
- **WHEN** a user toggles "Show markdown source" while viewing a rendered markdown file
- **THEN** the preview panel displays the unmodified raw file content as plain text

#### Scenario: Switching back to rendered
- **WHEN** a user toggles "Show rendered markdown" while viewing raw source
- **THEN** the preview panel displays the formatted rendering of the same file content

### Requirement: Read-only rendering
The system SHALL NOT allow editing of file content through the rendered markdown view.

#### Scenario: Attempting to edit rendered content
- **WHEN** a user interacts with the rendered markdown view (e.g. clicks or types within rendered text)
- **THEN** no changes are made to the underlying file content

### Requirement: Non-markdown files unaffected
The system SHALL continue to preview non-markdown files using their existing preview behavior.

#### Scenario: Opening a non-markdown file
- **WHEN** a user selects a file that is not `.md` or `.mdx` (e.g. source code or an image)
- **THEN** the preview panel displays it using the existing non-markdown preview behavior, unchanged
