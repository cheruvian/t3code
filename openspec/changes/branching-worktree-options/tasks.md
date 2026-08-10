## 1. Contracts

- [ ] 1.1 Extend `VcsCreateWorktreeInput` in `packages/contracts/src/git.ts` with a `source` field (`{ ref }` | `{ existingWorktreePath, includeUncommitted }` | `{ threadId, messageId }` | `{ sessionThreadId }`), defaulting to `{ ref: refName }` when omitted
- [ ] 1.2 Extend `VcsCreateWorktreeResult` with an optional `threadId`
- [ ] 1.3 Update the `WsVcsCreateWorktreeRpc` contract in `packages/contracts/src/rpc.ts` and IPC surface in `ipc.ts` for the extended shapes

## 2. Server: source resolution

- [ ] 2.1 In `GitWorkflowService`, add source-resolution logic that turns a `source.existingWorktreePath` into a resolved ref/path for `GitVcsDriverCore.createWorktree`
- [ ] 2.2 Implement uncommitted-changes copy: after `git worktree add`, apply the source worktree's diff (tracked) and copy untracked files, per design.md
- [ ] 2.3 Add rollback: if the uncommitted-changes copy fails, remove the partially-created worktree and return an error
- [ ] 2.4 Re-validate that the source worktree/thread/session belongs to the requesting project before acting on client-supplied IDs

## 3. Server: thread seeding

- [ ] 3.1 Implement `ThreadSeeder.seedFromMessage(threadId, messageId, newWorktreePath)` that creates a new thread in `ProjectionThreads` containing the conversation history up to and including the given message
- [ ] 3.2 Implement `ThreadSeeder.seedFromDistilledPrompt(sessionThreadId, newWorktreePath)` that runs a single best-effort LLM distillation of the session conversation and creates a new thread with that prompt as its only initial message
- [ ] 3.3 Fail closed: if distillation fails or produces no usable prompt, do not create the worktree; surface the error
- [ ] 3.4 If seeding fails after the worktree was already created, return a partial result (`threadId: null` + error) rather than rolling back the worktree

## 4. Server: RPC wiring

- [ ] 4.1 Update the `vcs.createWorktree` handler in `apps/server/src/ws.ts` to branch on `source` and call the appropriate resolution/seeding path
- [ ] 4.2 Add validation rejecting requests where `source` is missing or ambiguous (more than one variant populated)
- [ ] 4.3 Add error responses for: missing source worktree, missing/unavailable thread message state, distillation failure

## 5. Client/UI

- [ ] 5.1 Update `packages/client-runtime/src/state/vcs.ts` `createWorktree` call to accept and pass through `source`
- [ ] 5.2 Add UI in `BranchToolbarBranchSelector.tsx` for choosing "branch from existing worktree" (with a toggle for including uncommitted changes)
- [ ] 5.3 Add UI entry point (e.g. message context menu) for "branch worktree from this message"
- [ ] 5.4 Add UI entry point for "start new worktree from a clean prompt" off a prior session, including an editable preview of the distilled prompt before creation
- [ ] 5.5 Wire `ChatView.tsx` to open/focus the newly seeded thread once worktree + thread creation completes

## 6. Tests

- [ ] 6.1 Server unit tests for source resolution (existing worktree, with/without uncommitted changes)
- [ ] 6.2 Server unit tests for thread seeding (from message, from distilled prompt, including failure/rollback paths)
- [ ] 6.3 Contract/RPC tests for validation errors (missing source, ambiguous source, not-found source)
- [ ] 6.4 UI test coverage for the three new worktree-creation entry points
