# Local GoCD pipelines

This repository defines three GoCD pipelines for two immutable T3 server environments:

`candidate branch -> build -> deploy candidate -> verify candidate`

`fork main -> build -> deploy and verify production`

`manual production rollback -> swap to the previous release -> verify production`

The candidate pipeline tracks `candidate` and runs automatically. The production pipeline tracks
`main` on `https://github.com/cheruvian/t3code.git` and also runs automatically. A commit reaching
that fork's `main` branch is the production approval boundary: GoCD builds it once, deploys that
artifact, and verifies the running production backend. Production does not require a second push, a
second production branch, or a manual approval stage after `main`.

The two runtime environments remain isolated. Their databases live at:

- Candidate: `~/t3-runtime/staging/home/userdata/state.sqlite`, port `17773`
- Production: `~/t3-runtime/production/home/userdata/state.sqlite`, port `17774`

Candidate can therefore run long, stateful workflows without changing production. Each deployment
uses one build artifact throughout; later work does not rebuild a different revision.

## One-time GoCD setup

Install the GoCD server and agent on this Mac, start the server, and open
`http://localhost:8153/go`. Register the local agent with the resource `t3-local`.

Configure one YAML config repository that reads this repository's `main` branch and matches
`**/*.gocd.yaml`. It loads exactly these pipeline definitions:

- `t3code-candidate.gocd.yaml`
- `t3code-main.gocd.yaml`
- `t3code-production-rollback.gocd.yaml`

The candidate and production pipelines observe their Git materials automatically. The first stage
of `t3code-production-rollback` requires manual approval, so observing a new `main` revision never
starts a rollback. Starting that pipeline deliberately swaps production's `current` and `previous`
release pointers, launches the release that was one version back, and verifies it.
The emergency job reuses its existing material checkout and runs the dependency-free Node rollback
command directly, avoiding a clean clone and package install before an artifact-only rollback.

GoCD promotes committed material, not uncommitted worktree changes. Keep the production material at
`https://github.com/cheruvian/t3code.git` on `main`; the deployment command independently checks that
the artifact SHA is still the current head of that exact ref.

## Production transaction and recovery

Production `deploy`, `start`, `stop`, and `rollback` operations share a filesystem operation lock.
Only one process can mutate the production runtime and its release pointers at a time. Production
verification runs inside the same locked deploy or rollback transaction rather than in a later GoCD
stage. The lock records its owner and can be reclaimed only after that process has exited.
New launcher records include both the PID and an OS process-birth token. Before every signal, the
pipeline revalidates that token, the exact command, working directory, selected release, backend
runtime generation, and environment-port ownership as applicable. A stale, legacy, or reused
launcher PID is never signaled. When the launcher has already exited, an independently verified
backend is terminated directly, and replacement cannot start until that backend and every listener
on the environment port are gone.

Before stopping the active production process or changing `current`, deployment resolves the fork's
`main` head. It rejects an unavailable or malformed head and rejects any artifact whose manifest SHA
is no longer that head. This prevents an older queued build from replacing newer production code.

The production verifier binds an exact 40-character SHA to the selected release and the live backend.
It checks the `current` pointer and manifest, a newly launched runtime generation, exclusive
ownership of the production listener, the process working directory, an exact release command, and
HTTP readiness. Runtime state and the same process/listener identity are checked both before and
after HTTP, so an orphan's response or a listener handoff cannot satisfy readiness or final
verification.

Deploy and rollback both snapshot the original `current` and `previous` pointers. If the selected
release fails to launch or verify, the operation restores the complete pointer snapshot, relaunches
the original release, and verifies the restored runtime before returning the initiating failure. If
that recovery also fails, the command returns a compound failure containing both errors and leaves a
durable `manual-intervention-required.json` marker in the production runtime directory.

The pointer snapshot is written to `operation-transaction.json` before the process is stopped. If a
GoCD job or its host exits mid-deployment, the next production operation reclaims the dead owner's
lock, restores that snapshot, and verifies the original running release before doing new work. The
transaction record is removed only after deployment verification commits the new release or recovery
verifies the restored one.

A successful same-SHA deployment leaves `previous` unchanged. This makes an ordinary retry
idempotent while still allowing the same SHA to be deployed intentionally after a rollback; in that
case the release being replaced becomes `previous` again.

These guarantees apply to self-contained binary releases. A binary rollback does not reverse a
database migration because both production releases use the same production home and database.
Likewise, an initial deployment with no complete prior self-contained release cannot promise an
automatic fallback; a failed recovery records the manual-intervention marker instead.

## Local commands

Use the environment-named commands when bringing up GoCD or inspecting a runtime locally:

```bash
npm run pipeline:build
npm run pipeline:deploy:staging
npm run pipeline:status:staging
npm run pipeline:rollback:staging
npm run pipeline:deploy:production
npm run pipeline:status:production
npm run pipeline:rollback:production
```

The `candidate` aliases map to `staging`, and the `main` aliases map to `production`. Uncommitted
artifacts can be exercised in staging. A direct production deployment is not an approval bypass: its
artifact SHA must still match the current fork `main` head. Run the production rollback command only
as a deliberate local recovery action; normal GoCD rollback uses the manual
`t3code-production-rollback` pipeline.

## Staging test data

Do not point staging at the live T3 home. To seed staging from a consistent snapshot, stop any local
staging server, create its home, and use SQLite's backup operation:

```bash
mkdir -p "$HOME/t3-runtime/staging/home/userdata"
rm -f "$HOME/t3-runtime/staging/home/userdata/state.sqlite"*
SOURCE_HOME="$HOME/.t3/userdata" \
  TARGET_DB="$HOME/t3-runtime/staging/home/userdata/state.sqlite" \
  bun -e 'const db = new (require("bun:sqlite").Database)(process.env.SOURCE_HOME + "/state.sqlite", { readonly: true }); db.run(`VACUUM INTO "${process.env.TARGET_DB}"`);'
```

Copy secrets only when the workflow requires them, and copy them into staging rather than sharing
production files. Exercise database migrations in staging before merging them to `main`. Staging and
production databases remain separate, and the pipeline does not perform automatic schema
compatibility analysis.

## Verification boundary

Candidate verification checks HTTP readiness and the required self-contained release files.
Production adds the exact runtime-identity checks described above. These are release-health checks,
not a full user-session workflow gate; add an approved Playwright or session workflow to candidate
verification before relying on it for end-to-end behavior.
