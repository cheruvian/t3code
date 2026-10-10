import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProjectResourceLock,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect(
      "keeps resource ownership and inherited-action preferences across unrelated project edits",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectStore.ProjectStoreV2;
          const projectId = ProjectId.make("resource-project");
          const lock: ProjectResourceLock = {
            script: {
              id: "device",
              name: "Device",
              command: "",
              icon: "play",
              runOnWorktreeCreate: false,
              resource: {
                color: "#3366ff",
                checkoutPrompt: "",
                releaseCommand: "",
                releasePrompt: "",
              },
            },
            threadId: ThreadId.make("owner"),
            operationId: CommandId.make("checkout"),
            phase: "held",
          };
          const base = {
            aggregateKind: "project" as const,
            aggregateId: projectId,
            occurredAt: "2026-10-03T00:00:00.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
          };
          yield* projects.apply({
            ...base,
            sequence: 1,
            eventId: EventId.make("create-resource-project"),
            type: "project.created",
            payload: {
              projectId,
              title: "Resource project",
              workspaceRoot: "/tmp/resource-project",
              defaultModelSelection: null,
              scripts: [],
              resourceLocks: [lock],
              disabledInheritedScriptIds: ["shared-setup"],
              createdAt: base.occurredAt,
              updatedAt: base.occurredAt,
            },
          });
          yield* projects.apply({
            ...base,
            sequence: 2,
            eventId: EventId.make("rename-resource-project"),
            type: "project.meta-updated",
            payload: { projectId, title: "Renamed", updatedAt: base.occurredAt },
          });
          const shell = Option.getOrThrow(yield* projects.getShell(projectId));
          assert.equal(shell.title, "Renamed");
          assert.deepEqual(shell.resourceLocks, [lock]);
          assert.deepEqual(shell.disabledInheritedScriptIds, ["shared-setup"]);
          yield* projects.apply({
            ...base,
            sequence: 3,
            eventId: EventId.make("release-resource-project"),
            type: "project.meta-updated",
            payload: {
              projectId,
              resourceLocks: [],
              disabledInheritedScriptIds: [],
              updatedAt: base.occurredAt,
            },
          });
          const released = Option.getOrThrow(yield* projects.getShell(projectId));
          assert.deepEqual(released.resourceLocks, []);
          assert.deepEqual(released.disabledInheritedScriptIds, []);
        }),
    );
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );
  },
);
