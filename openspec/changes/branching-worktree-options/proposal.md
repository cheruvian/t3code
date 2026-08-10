## Why

Today a worktree can only be created from a ref name (`VcsCreateWorktreeInput.refName`) — there is no way to branch a new worktree off the state of an *existing* worktree, off a specific message in an ongoing thread, or off a clean prompt carried over from a prior session conversation. Users who want to explore an alternate direction mid-task currently have to manually create a worktree and re-type context by hand, losing the thread history that motivated the fork.

## What Changes

- Add a "branch worktree" flow that creates a new worktree seeded from the current state of an existing worktree (same uncommitted/staged changes or branch tip, at the user's choice).
- Add the ability to fork a new worktree from a specific message within an existing thread, carrying that message (and prior context up to that point) into a new thread rooted in the new worktree.
- Add the ability to start a new worktree from a "clean prompt" derived from a prior session conversation — i.e., summarize/extract a fresh prompt from an existing conversation without carrying full thread history, then seed a new thread in a new worktree with that prompt.
- Extend the worktree-creation UI (`BranchToolbarBranchSelector`, `ChatView` auto-worktree logic) to surface these three branching sources as explicit options rather than only "new branch from ref."
- Extend the `vcs.createWorktree` RPC contract with an optional `source` describing how the worktree/thread should be seeded (existing worktree, thread message, or session-derived prompt), and add a way to send the resulting seed content into the new thread.

## Capabilities

### New Capabilities
- `worktree-branching`: creating a new worktree from three additional sources — an existing worktree's state, a message within a worktree's thread, or a clean prompt distilled from a prior session conversation — and seeding the resulting thread appropriately.

### Modified Capabilities
(none — no existing spec covers worktree creation today)

## Impact

- `packages/contracts/src/git.ts` — extend `VcsCreateWorktreeInput` (or add a new input variant) with a `source` field.
- `apps/server/src/vcs/GitVcsDriverCore.ts`, `GitWorkflowService.ts`, `GitVcsDriver.ts` — implement the new source-handling logic (branching off an existing worktree's ref/changes).
- `apps/server/src/ws.ts` — `vcs.createWorktree` RPC handler updates to accept and process the new `source` field.
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` — logic to seed a new thread from a source message or a distilled prompt.
- `apps/web/src/components/BranchToolbarBranchSelector.tsx`, `BranchToolbar.tsx`, `ChatView.tsx` — UI entry points for selecting a branching source when creating a worktree.
- `packages/client-runtime/src/state/vcs.ts` — client-side RPC call updates.
