## Purpose

Gives readers of a markdown file in the file browser a way to leave anchored comments and see which sections have been reviewed, so markdown files can be used as a review surface.

## ADDED Requirements

### Requirement: Anchored comments on rendered markdown
The system SHALL let a user attach a comment to a specific location (section or selected text) within a rendered markdown file.

#### Scenario: Adding a comment to a text selection
- **WHEN** a user selects a range of rendered text in a markdown file and adds a comment
- **THEN** the comment is stored anchored to that text location and is displayed alongside the rendered content at that location

#### Scenario: Reopening a file with existing comments
- **WHEN** a user reopens a markdown file that has previously anchored comments
- **THEN** the system displays each comment anchored at its original location if the underlying text is unchanged

### Requirement: Anchor resolution on changed content
The system SHALL resolve each comment's anchor against the current file content as exact, approximate, or detached, and SHALL NOT silently attach a comment to unrelated text.

#### Scenario: Anchored text still present unchanged
- **WHEN** the file content at a comment's anchor location has not changed since the comment was created
- **THEN** the comment is shown as exactly anchored at that location

#### Scenario: Anchored text changed nearby
- **WHEN** the file content has changed in a way that shifts but does not remove the anchored text
- **THEN** the comment is shown as approximately anchored, indicating its position may have moved

#### Scenario: Anchored text removed
- **WHEN** the anchored text no longer exists in the file
- **THEN** the comment is shown as detached rather than attached to unrelated content

### Requirement: Section review status
The system SHALL derive and display a reviewed, changed, or unreviewed status for each section of a markdown file based on comparing the section's current content hash to its last-reviewed content hash.

#### Scenario: Section marked reviewed
- **WHEN** a user signs off on a section's current content
- **THEN** that section is shown as reviewed until its content changes

#### Scenario: Reviewed section edited
- **WHEN** a previously reviewed section's content changes after sign-off
- **THEN** that section is shown as changed rather than reviewed

#### Scenario: Section never reviewed
- **WHEN** a section has no prior sign-off record
- **THEN** that section is shown as unreviewed

### Requirement: Review surface scoped to markdown files
The system SHALL only offer anchored commenting and review status on markdown file previews, leaving non-markdown file preview behavior unchanged.

#### Scenario: Opening a non-markdown file
- **WHEN** a user opens a non-markdown file in the file browser
- **THEN** no anchored-comment or review-status affordances from the markdown review surface are shown
