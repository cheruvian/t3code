import { EventId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  ACTIVITY_PAYLOAD_SLIM_VERSION,
  projectPayload,
  projectThreadDetailSnapshot,
} from "../ActivityPayloadProjection.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const slimLayer = it.layer(
  Layer.mergeAll(
    OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
    ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
);

const projectId = ProjectId.make("project-slim");

/**
 * Activity payloads whose slim projection is materially smaller than the
 * stored one, covering both slimming branches (regular tool data and the MCP
 * carve-out) plus a lifecycle pair the snapshot drop passes act on.
 */
const activityFixtures = [
  {
    suffix: "cmd",
    turnId: "turn-1",
    kind: "tool.completed",
    summary: "Ran a command",
    payload: {
      itemType: "command_execution",
      title: "pnpm test",
      detail: "running",
      data: {
        toolCallId: "call-cmd",
        command: "pnpm test",
        rawOutput: { content: "first useful line\n" + "noise\n".repeat(2_000) },
        transcript: "x".repeat(20_000),
      },
    },
  },
  {
    suffix: "upd",
    turnId: "turn-1",
    kind: "tool.updated",
    summary: "Edit src/app.ts",
    payload: {
      itemType: "file_change",
      title: "Edit src/app.ts",
      detail: "writing",
      data: {
        toolCallId: "call-edit",
        toolName: "Edit",
        patch: "y".repeat(30_000),
      },
    },
  },
  {
    suffix: "done",
    turnId: "turn-1",
    kind: "tool.completed",
    summary: "Edit src/app.ts",
    payload: {
      itemType: "file_change",
      title: "Edit src/app.ts",
      detail: "writing",
      data: {
        toolCallId: "call-edit",
        toolName: "Edit",
        item: { changes: [{ filePath: "src/app.ts", patch: "z".repeat(30_000) }] },
      },
    },
  },
  {
    suffix: "mcp",
    turnId: "turn-1",
    kind: "tool.completed",
    summary: "Fetched a PR",
    payload: {
      itemType: "mcp_tool_call",
      title: "github fetch_pr",
      detail: "done",
      data: {
        item: {
          tool: "fetch_pr",
          server: "github",
          status: "completed",
          arguments: { pr: 42 },
          result: { content: [{ type: "text", text: `PR body\n${"q".repeat(20_000)}` }] },
        },
      },
    },
  },
  {
    suffix: "ctx-stale",
    turnId: "turn-1",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: { usedTokens: 1_000, maxTokens: 200_000 },
  },
  {
    suffix: "ctx-latest",
    turnId: "turn-1",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: { usedTokens: 2_000, maxTokens: 200_000 },
  },
] as const;

const insertThreadRow = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id,
        project_id,
        title,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        branch,
        worktree_path,
        latest_turn_id,
        latest_user_message_at,
        pending_approval_count,
        pending_user_input_count,
        has_actionable_proposed_plan,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (
        ${threadId},
        ${projectId},
        'Slim payload thread',
        '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access',
        'default',
        NULL,
        NULL,
        NULL,
        NULL,
        0,
        0,
        0,
        '2026-08-17T00:00:00.000Z',
        '2026-08-17T00:00:01.000Z',
        NULL
      )
    `;
  });

const seedActivities = (threadId: string) =>
  Effect.gen(function* () {
    const activities = yield* ProjectionThreadActivityRepository;
    yield* insertThreadRow(threadId);
    yield* Effect.forEach(
      activityFixtures,
      (fixture, index) =>
        activities.upsert({
          activityId: EventId.make(`${threadId}-${fixture.suffix}`),
          threadId: ThreadId.make(threadId),
          turnId: TurnId.make(fixture.turnId),
          tone: fixture.kind.startsWith("tool") ? "tool" : "info",
          kind: fixture.kind,
          summary: fixture.summary,
          payload: fixture.payload,
          sequence: index,
          createdAt: "2026-08-17T00:00:02.000Z",
        }),
      { concurrency: 1 },
    );
  });

const readProjectedActivities = (threadId: string) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(ThreadId.make(threadId));
    if (Option.isNone(snapshot)) {
      return yield* Effect.die(`Expected a detail snapshot for ${threadId}.`);
    }
    return projectThreadDetailSnapshot(snapshot.value).thread.activities;
  });

/** Activity ids embed their thread, so drop them before comparing threads. */
const withoutIds = (activities: ReadonlyArray<{ readonly id: string }>) =>
  activities.map(({ id: _id, ...rest }) => rest);

const resetProjections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_thread_activities`;
  yield* sql`DELETE FROM projection_threads`;
});

slimLayer("pre-slimmed activity payload column", (it) => {
  it.effect("stores a slimmed payload and its version stamp next to the full payload", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetProjections;
      yield* seedActivities("thread-slim");

      const rows = yield* sql<{
        readonly full: string;
        readonly slim: string | null;
        readonly version: number | null;
      }>`
        SELECT
          payload_json AS "full",
          payload_slim_json AS "slim",
          payload_slim_version AS "version"
        FROM projection_thread_activities
        WHERE activity_id = 'thread-slim-cmd'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected the seeded activity row to exist.");
      }

      assert.equal(row.version, ACTIVITY_PAYLOAD_SLIM_VERSION);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.equal(row.slim, JSON.stringify(projectPayload(activityFixtures[0].payload)));
      assert.isBelow((row.slim ?? "").length, row.full.length / 10);
    }),
  );

  it.effect("leaves the slim column NULL when slimming is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetProjections;
      yield* seedActivities("thread-slim");

      // Context-window payloads carry no `data`, so a slim copy would just
      // duplicate `payload_json`; the read falls back to it instead.
      const rows = yield* sql<{
        readonly slim: string | null;
        readonly version: number | null;
      }>`
        SELECT payload_slim_json AS "slim", payload_slim_version AS "version"
        FROM projection_thread_activities
        WHERE activity_id = 'thread-slim-ctx-latest'
      `;
      assert.equal(rows[0]?.slim, null);
      assert.equal(rows[0]?.version, ACTIVITY_PAYLOAD_SLIM_VERSION);

      const activities = yield* readProjectedActivities("thread-slim");
      assert.deepStrictEqual(
        activities.find((activity) => activity.id === "thread-slim-ctx-latest")?.payload,
        activityFixtures[5].payload,
      );
    }),
  );

  it.effect("serves the stored slim payload without re-running the projection", () =>
    Effect.gen(function* () {
      yield* resetProjections;
      yield* seedActivities("thread-slim");

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(ThreadId.make("thread-slim"));
      if (Option.isNone(snapshot)) {
        return yield* Effect.die("Expected a detail snapshot.");
      }

      const read = snapshot.value.thread.activities.find(
        (activity) => activity.id === "thread-slim-cmd",
      );
      assert.deepStrictEqual(read?.payload, projectPayload(activityFixtures[0].payload));

      // The read path marked the payload, so the slimming pass leaves the very
      // same object in place instead of rebuilding it.
      const projected = projectThreadDetailSnapshot(snapshot.value).thread.activities.find(
        (activity) => activity.id === "thread-slim-cmd",
      );
      assert.strictEqual(projected, read);
      assert.strictEqual(projected?.payload, read?.payload);
    }),
  );

  it.effect("matches the payload_json fallback row for row, drops included", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetProjections;
      yield* seedActivities("thread-slim");
      yield* seedActivities("thread-legacy");
      // Rows written before migration 039 carry NULL slim columns.
      yield* sql`
        UPDATE projection_thread_activities
        SET payload_slim_json = NULL, payload_slim_version = NULL
        WHERE thread_id = 'thread-legacy'
      `;

      const fromSlim = yield* readProjectedActivities("thread-slim");
      const fromFull = yield* readProjectedActivities("thread-legacy");

      assert.deepStrictEqual(withoutIds(fromSlim), withoutIds(fromFull));
      // The drop passes actually removed rows, so the comparison is not vacuous.
      assert.isBelow(fromSlim.length, activityFixtures.length);
      assert.deepStrictEqual(
        fromSlim.map((activity) => activity.id),
        ["thread-slim-cmd", "thread-slim-done", "thread-slim-mcp", "thread-slim-ctx-latest"],
      );
    }),
  );

  it.effect("keeps the whole-database read model on the full payload", () =>
    Effect.gen(function* () {
      yield* resetProjections;
      yield* seedActivities("thread-slim");

      // `getSnapshot` is the oracle for what the projector persisted, so it
      // must keep reporting payloads verbatim even once slim copies exist.
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const readModel = yield* snapshotQuery.getSnapshot();
      const activity = readModel.threads
        .find((thread) => thread.id === "thread-slim")
        ?.activities.find((entry) => entry.id === "thread-slim-cmd");

      assert.deepStrictEqual(activity?.payload, activityFixtures[0].payload);
    }),
  );

  it.effect("ignores a slim payload stamped with a superseded version", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetProjections;
      yield* seedActivities("thread-slim");
      yield* seedActivities("thread-stale");
      yield* sql`
        UPDATE projection_thread_activities
        SET payload_slim_json = '{"itemType":"stale","data":{}}',
            payload_slim_version = ${ACTIVITY_PAYLOAD_SLIM_VERSION - 1}
        WHERE thread_id = 'thread-stale'
      `;

      const fromSlim = yield* readProjectedActivities("thread-slim");
      const fromStale = yield* readProjectedActivities("thread-stale");

      assert.deepStrictEqual(withoutIds(fromStale), withoutIds(fromSlim));
    }),
  );
});
