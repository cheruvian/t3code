## Purpose

Lets users create a new worktree seeded from an existing worktree's state, a specific thread message, or a clean prompt distilled from a prior session, instead of only from a bare branch/ref name.

## ADDED Requirements

### Requirement: Branch a worktree from an existing worktree
The system SHALL allow a user to create a new worktree whose starting state is derived from an existing worktree, rather than only from a bare ref name.

#### Scenario: Create from existing worktree's current branch
- **WHEN** a user chooses to branch a new worktree from an existing worktree and selects "current branch tip"
- **THEN** the system creates a new worktree checked out at the same commit as the source worktree's current branch tip

#### Scenario: Create from existing worktree including uncommitted changes
- **WHEN** a user chooses to branch a new worktree from an existing worktree and selects "include uncommitted changes"
- **THEN** the system creates a new worktree whose working tree includes the source worktree's uncommitted and staged changes at the time of creation

#### Scenario: Source worktree no longer exists
- **WHEN** a user attempts to branch from an existing worktree that has since been removed
- **THEN** the system rejects the request with an error identifying the missing source worktree, and creates no new worktree

### Requirement: Branch a worktree from a thread message
The system SHALL allow a user to create a new worktree and a new thread seeded from a specific message within an existing thread, carrying forward the conversation context up to and including that message.

#### Scenario: Fork from a mid-conversation message
- **WHEN** a user selects a message in an existing thread and chooses to branch a new worktree from it
- **THEN** the system creates a new worktree and a new thread whose initial context includes the conversation history up to and including the selected message

#### Scenario: Source thread's code state at time of message is unavailable
- **WHEN** a user branches from a thread message but the underlying commit/state associated with that point in the conversation is no longer available in the repository
- **THEN** the system rejects the request with an error explaining the state is unavailable, and creates no new worktree

### Requirement: Branch a worktree from a clean prompt derived from a prior session
The system SHALL allow a user to create a new worktree and a new thread seeded by a clean prompt distilled from a prior session's conversation, without carrying over the full message history of that session.

#### Scenario: Start new worktree from distilled prompt
- **WHEN** a user chooses to branch a new worktree "from a clean prompt" based on a prior session conversation
- **THEN** the system generates a single distilled prompt summarizing the relevant intent of that conversation and creates a new worktree with a new thread whose only initial message is that distilled prompt

#### Scenario: Distillation fails or produces no usable prompt
- **WHEN** the system cannot distill a usable prompt from the selected prior session
- **THEN** the system reports the failure to the user and creates no new worktree

### Requirement: Branching source is explicit in the create-worktree request
The system SHALL require every worktree-creation request to declare its source explicitly: a bare ref/branch, an existing worktree, a thread message, or a distilled session prompt.

#### Scenario: Request omits a source
- **WHEN** a worktree-creation request does not specify any of the supported source types
- **THEN** the system rejects the request with a validation error and creates no worktree
