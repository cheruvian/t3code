# Local GoCD pipeline

This repository includes two GoCD pipelines for running two immutable T3 server artifacts:

`candidate branch -> candidate app -> candidate verification`

`main branch -> manual approval -> main app -> main verification`

The two environments are isolated T3 installations. Their databases live at:

- Candidate: `~/t3-runtime/staging/home/userdata/state.sqlite`, port `17773`
- Main: `~/t3-runtime/production/home/userdata/state.sqlite`, port `17774`

That separation is intentional: staging can run a long, stateful workflow without changing production. A failed deployment restores the prior release automatically; `pipeline:rollback:*` is available for a later health or workflow failure.

## One-time GoCD setup

Install the GoCD server and agent on this Mac, start the server, and open `http://localhost:8153/go`. Register the local agent with the resource `t3-local`.

Configure a YAML config repository pointing at this repository and matching `**/*.gocd.yaml`. This loads [t3code-candidate.gocd.yaml](/Users/cheruvian/.t3/worktrees/t3code/t3code-candidate.gocd.yaml) and [t3code-main.gocd.yaml](/Users/cheruvian/.t3/worktrees/t3code/t3code-main.gocd.yaml). Change the Git material if this fork uses another remote. GoCD promotes committed material, not uncommitted worktree changes.

The candidate pipeline tracks `candidate` and deploys automatically. The main pipeline tracks `main` and waits for manual approval before deploying. Each pipeline builds once, then every later stage fetches that same tarball; it does not rebuild.

## Local commands

```bash
npm run pipeline:build
npm run pipeline:deploy:candidate
npm run pipeline:status:candidate
npm run pipeline:rollback:candidate
npm run pipeline:deploy:main
npm run pipeline:status:main
npm run pipeline:rollback:main
```

The direct commands are useful while bringing up GoCD or testing an uncommitted worktree. Normally GoCD owns candidate promotion and the manual approval before main promotion.

## Staging test data

Do not point staging at the live T3 home. To seed staging from a consistent snapshot, stop any local staging server, create its home, and use SQLite's backup operation:

```bash
mkdir -p "$HOME/t3-runtime/staging/home/userdata"
rm -f "$HOME/t3-runtime/staging/home/userdata/state.sqlite"*
SOURCE_HOME="$HOME/.t3/userdata" \
  TARGET_DB="$HOME/t3-runtime/staging/home/userdata/state.sqlite" \
  bun -e 'const db = new (require("bun:sqlite").Database)(process.env.SOURCE_HOME + "/state.sqlite", { readonly: true }); db.run(`VACUUM INTO "${process.env.TARGET_DB}"`);'
```

Copy secrets only when the workflow requires them, and copy them into staging rather than sharing the production files. If a release contains a database migration, staging must be migrated and exercised before production approval. This first version deliberately keeps staging and production databases separate; it does not attempt automatic schema compatibility analysis.

## Current verification boundary

The checked-in verification jobs currently perform an HTTP readiness smoke check. Add the approved Playwright/session workflow command to `verify-staging.mjs` before treating the pipeline as a full release gate. Production is never promoted automatically, and a failed startup readiness check restores the previous release.
