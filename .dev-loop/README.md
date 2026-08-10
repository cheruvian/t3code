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

   Verification and human review require separate browser pairing credentials.
   Let the controlled verification browser consume one token on its first
   navigation, then mint a fresh token for the reviewer with:

   ```bash
   node apps/server/src/bin.ts pair
   ```

   Hand the reviewer the complete `/pair#token=...` URL, not the bare local
   origin and not a token already opened by automation. Pairing is browser-local;
   authenticating the verification browser does not authenticate the reviewer's
   browser. Do not disable local authentication for verification.

   The startup pairing URL carries admin scopes; tokens minted with `pair` carry
   standard client scopes. If the reviewer needs admin-only Settings surfaces,
   restart the isolated server, reserve the new startup URL for the reviewer,
   and mint a separate standard token for automation.

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

## Propagating an updated candidate to fork main

When the previous release candidate was recently cherry-picked onto the fork's
`main`, replace that candidate with the new squashed release commit instead of
stacking incremental review-fix commits on top. This keeps the release candidate
as the canonical feature commit on fork main.

Treat this as an explicit, bounded history rewrite. Inspect every commit after
the previous candidate and proceed only when they are known, replayable, and the
user has approved updating fork main. Create a local recovery ref, rebuild from
the previous candidate's parent, cherry-pick the new `release/<FEATURE>` commit,
then replay subsequent unrelated commits in order. Omit later fix commits whose
changes are already included in the new candidate. Verify the reconstructed
tree and use `--force-with-lease` when publishing it.

If the previous candidate is not recent, cannot be identified unambiguously, or
has shared descendants that are unsafe to replay, do not rewrite main. Stop and
ask whether to append an incremental fix or use another integration strategy.

Keep verification artifacts under `.dev-loop/artifacts/`; they are local
evidence and are intentionally ignored rather than committed with the feature.
Ignoring an artifact in Git does not authorize uploading or attaching it to a
PR.
