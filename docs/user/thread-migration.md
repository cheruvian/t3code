# Threads from older T3 Code versions

On your first V2 launch, T3 Code copies the V1 database, `state.sqlite`, into `statev2.sqlite`
in the same data directory and migrates the copy. Your threads appear automatically, with full
transcripts imported as needed. You do not need to run an import command.

V1 continues using its original database while V2 uses the copy. The database import can run while
V1 is open. Opening V2 again resumes your V2 history. The copy happens only once: later conversations
and changes in either version do not sync to the other. Settings, attachments, and workspace files
remain shared.

The V2 desktop app uses a separate browser profile, so browser cookies and caches do not carry
over from V1. You may need to sign in again to websites opened inside the app.

The migrated thread keeps its title, project, provider and model selection, permission and
interaction modes, branch or worktree, archive state, settlement state, snooze and pin state, and
linked pull request. T3 Code also brings over user and assistant messages, their timestamps, and
supported attachments. Large histories may appear in stages while the server imports transcripts.

The migration does not recreate the old provider's live session. It also does not convert old run
records, checkpoints and diffs, tool activity, approval history, or proposed plan history into the
new format. These items may be absent from a migrated timeline even though the conversation text is
present.

## Continuing a migrated thread

The first new message starts a fresh provider session. T3 Code selects intact user and assistant
messages using the same [handoff budget](./portable-handoffs.md) as a provider switch. Omitted text
remains in the thread and can be retrieved by the agent. The migration retains its separate
32,000-character recovery excerpt; neither that excerpt nor the handoff replaces the full imported
transcript.

Before continuing a long or important thread, read the recent transcript and include any older
requirements the agent still needs in your next message. Starting a new thread and pasting a short
handoff is also a good choice when the old conversation contains conflicting instructions.

## Keeping a recovery copy

Before a major server update, stop
the server and copy its `userdata` directory to a safe location. The default is
`~/.t3/userdata`; a server started with `--home-dir <path>` uses `<path>/userdata`.

If a migrated transcript is missing from the app, keep that copy unchanged. You can inspect the
old transcript without starting a server against it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

At the SQLite prompt, list recent legacy threads:

```sql
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;
```

Then print one transcript, replacing `<thread-id>` with the value from the first query:

```sql
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```

Open only the copied database. Do not edit it or point a newer or older server at your recovery
copy. If the affected environment is remote, make and inspect the copy on the machine that runs
that environment.

## Moving a thread to another environment

Connect both environments and open the same repository as a project on the destination.
Configure and sign in to Codex or Claude there. In the thread menu, choose **Move to environment**
and select the destination. Both servers must support thread moves.

The thread must be stopped and use its own Git worktree. T3 Code transfers its history,
attachments, checkpoints, committed files, staged changes, and other non-ignored files. The
provider resumes the same native session. Provider credentials stay on their own machines.
Ignored files and untracked `node_modules` are excluded. T3 Code runs the destination project’s
configured setup script after import to install dependencies and prepare local configuration.
Without a setup script, install dependencies or recreate local configuration yourself.
Threads with child agents or shared lineage, sparse checkouts, submodules, and unsupported Git
index layouts cannot move.

The destination receives a clean worktree and branch at the same commit, then applies the source’s
changes. Shared Git history is reused when available. After the destination
confirms success, the source becomes an ordinary settled thread. Its worktree and native session
files remain available, and you can reopen it normally. If the move is interrupted, reconnect both
environments and select the move action again to retry. A move that needs reconciliation keeps the
source intact and blocks new work until its outcome is confirmed.

Moving the thread back updates an untouched matching copy in place, preserving the same T3 thread
and provider session identities. T3 Code keeps the replaced worktree and session artifacts for
recovery. If the matching destination copy has new work, a running task, or an open terminal, the
move stops with a conflict instead of merging or overwriting it.

Before changing or continuing the destination thread, choose **Undo move** in its thread menu.
Both environments must be connected. Undo settles the destination and reopens the source. It
refuses to discard changes made after the move.
