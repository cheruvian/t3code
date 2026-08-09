# Dev-loop release branches

Use a feature branch for the whole change and keep its name stable:

```text
feature/<FEATURE>
```

When the feature is verified and ready for release review:

1. Ensure the feature branch is clean, its focused checks and real-surface
   verification are complete, and it is based on the current upstream main:

   ```bash
   git fetch upstream main
   git switch feature/<FEATURE>
   git rebase upstream/main
   ```
2. Refresh the isolated worktree database before release verification. Stop
   any dev server using this worktree, then run:

   ```bash
   vp run migrate-dev-db
   ```

   This snapshots the real database read-only into the worktree's `.t3`
   directory, prunes it, and runs migrations. Pair a fresh dev client after
   the refresh. Never point this command at shared `~/.t3` state.
3. Create the release branch from the same upstream main base:

   ```bash
   git switch -c release/<FEATURE> upstream/main
   ```

4. Squash-merge the entire feature branch into the release branch. The
   release branch should contain one Conventional Commit representing the
   complete feature, not the feature branch's iterative development history:

   ```bash
   git merge --squash feature/<FEATURE>
   git commit -m "feat(<scope>): <resulting feature behavior>"
   ```

5. Stop at the publication gate and ask whether to create a PR. A release
   candidate is not permission to publish it. Confirm whether the change should
   remain local, be pushed only to a private fork, or be opened publicly against
   upstream. Do not infer consent from earlier requests to commit, verify,
   squash, or prepare a release branch.

   Before publishing, review the proposed diff, PR title and body, screenshots,
   recordings, logs, and verification artifacts for code or workspace details
   that should not be shared. Local evidence may contain repository names,
   filesystem paths, thread titles, user data, or credentials even when the code
   diff is safe to publish. Redact or recapture evidence as needed, and omit it
   when it is not required for the approved destination.

6. Only after explicit approval, push the release branch to the approved remote
   and create the PR if requested. Because the release branch is the disposable
   release projection, update it with the lease-protected force form:

   ```bash
   git push --force-with-lease origin HEAD:release/<FEATURE>
   ```

Keep verification artifacts under `.dev-loop/artifacts/`; they are local
evidence and are intentionally ignored rather than committed with the feature.
Ignoring an artifact in Git does not authorize uploading or attaching it to a
PR.
