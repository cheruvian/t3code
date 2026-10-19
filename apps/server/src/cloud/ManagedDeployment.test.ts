import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Admission from "./DeploymentAdmission.ts";
import * as Deployment from "./ManagedDeployment.ts";

const id = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT, ordinal INTEGER DEFAULT 1)`;
  yield* sql`CREATE TABLE orchestration_v2_effect_outbox (status TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_runtime_requests (thread_id TEXT, status TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, status TEXT, payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, type TEXT, status TEXT)`;
  const directory = `${config.baseDir}/runtime`;
  yield* fs.makeDirectory(directory, { recursive: true });
  const request = (requestId = id) =>
    fs.writeFileString(
      `${directory}/deployment-request.json`,
      encode({
        id: requestId,
        revision: "a".repeat(40),
        queuedAt: "2026-10-15T00:00:00Z",
        status: "queued",
      }),
    );
  return {
    fs,
    sql,
    directory,
    request,
    service: yield* Deployment.ManagedDeployment,
    admission: yield* Admission.DeploymentAdmission,
  };
});
const dependencies = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-queued-deployment-" }),
  NodeSqliteClient.layer({ filename: ":memory:" }),
  Admission.layer,
  Layer.succeed(ServerActivation.ServerActivation, Effect.never),
).pipe(Layer.provideMerge(NodeServices.layer));
const layer = Deployment.layer.pipe(Layer.provideMerge(dependencies));

describe("queued deployments", () => {
  it.effect(
    "waits for turns and checkpoint effects, then freezes command admission before approval",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.request();
        yield* h.sql`INSERT INTO orchestration_v2_projection_runs (thread_id, status) VALUES ('thread', 'running')`;
        yield* h.service.reconcile;
        assert.isFalse(yield* h.fs.exists(`${h.directory}/deployment-decision.json`));
        yield* h.sql`DELETE FROM orchestration_v2_projection_runs`;
        yield* h.sql`INSERT INTO orchestration_v2_effect_outbox VALUES ('pending')`;
        yield* h.service.reconcile;
        assert.isFalse(yield* h.fs.exists(`${h.directory}/deployment-decision.json`));
        yield* h.sql`DELETE FROM orchestration_v2_effect_outbox`;
        yield* h.service.reconcile;
        assert.isTrue(yield* h.fs.exists(`${h.directory}/deployment-decision.json`));
        assert.isFalse(h.admission.enter());
      }).pipe(Effect.provide(layer)),
  );
  it.effect("ignores a queued run superseded by a completed turn and publishes completion", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.request();
      yield* h.sql`INSERT INTO orchestration_v2_projection_runs VALUES ('thread', 'queued', 1)`;
      assert.equal((yield* h.service.state)?.busyThreads, 1);
      yield* h.service.reconcile;
      assert.isFalse(yield* h.fs.exists(`${h.directory}/deployment-decision.json`));
      yield* h.sql`INSERT INTO orchestration_v2_projection_runs VALUES ('thread', 'completed', 2)`;
      assert.equal((yield* h.service.state)?.busyThreads, 0);
      yield* h.service.reconcile;
      assert.equal((yield* h.service.state)?.status, "installing");
      yield* h.fs.writeFileString(
        `${h.directory}/deployment-result-${id}.json`,
        encode({ status: "succeeded" }),
      );
      assert.isNull(yield* h.service.state);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("does not approve while an admitted command is still committing", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.request();
      assert.isTrue(h.admission.enter());
      yield* h.service.reconcile;
      assert.isFalse(yield* h.fs.exists(`${h.directory}/deployment-decision.json`));
      h.admission.leave();
      yield* h.service.reconcile;
      assert.isFalse(h.admission.enter());
    }).pipe(Effect.provide(layer)),
  );
  it.effect("rejects stale force requests and approves only the replacement revision", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.request();
      yield* h.request(nextId);
      const error = yield* h.service.action({ id, action: "force" }).pipe(Effect.flip);
      assert.equal(error._tag, "ManagedDeploymentError");
      yield* h.service.action({ id: nextId, action: "force" });
      const decision = yield* h.fs.readFileString(`${h.directory}/deployment-decision.json`);
      assert.include(decision, nextId);
      assert.isFalse(h.admission.enter());
    }).pipe(Effect.provide(layer)),
  );
  it.effect("cancel removes the notice, restores admission, and never gets auto-approved", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.request();
      yield* h.service.action({ id, action: "cancel" });
      yield* h.service.reconcile;
      assert.isNull(yield* h.service.state);
      assert.isTrue(h.admission.enter());
      h.admission.leave();
      assert.include(
        yield* h.fs.readFileString(`${h.directory}/deployment-decision.json`),
        "cancel",
      );
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "force proceeds with active work and a failed deployment restores command admission",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.request();
        yield* h.sql`INSERT INTO orchestration_v2_projection_runs (thread_id, status) VALUES ('thread', 'running')`;
        yield* h.service.action({ id, action: "force" });
        assert.isFalse(h.admission.enter());
        yield* h.fs.writeFileString(
          `${h.directory}/deployment-result-${id}.json`,
          encode({ status: "failed" }),
        );
        yield* h.service.reconcile;
        assert.equal((yield* h.service.state)?.status, "failed");
        assert.isTrue(h.admission.enter());
        h.admission.leave();
      }).pipe(Effect.provide(layer)),
  );
  it.effect("keeps admission frozen if a newer request arrives during installation", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.request();
      yield* h.service.action({ id, action: "force" });
      yield* h.fs.writeFileString(
        `${h.directory}/deployment-installing.json`,
        encode({
          id,
          revision: "a".repeat(40),
          queuedAt: "2026-10-15T00:00:00Z",
          status: "installing",
        }),
      );
      yield* h.fs.writeFileString(
        `${h.directory}/deployment-result-${id}.json`,
        encode({ status: "installing" }),
      );
      yield* h.request(nextId);
      yield* h.service.reconcile;
      assert.equal((yield* h.service.state)?.id, id);
      assert.isFalse(h.admission.enter());
      yield* h.service.action({ id: nextId, action: "cancel" }).pipe(Effect.flip);
      assert.isFalse(h.admission.enter());
    }).pipe(Effect.provide(layer)),
  );
  it.effect("waits for provider background work even after the agent turn ended", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.request();
      yield* h.sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('thread', 'idle', ${encode({ pendingBackgroundTasks: [{}] })})`;
      yield* h.service.reconcile;
      assert.equal((yield* h.service.state)?.busyThreads, 1);
      assert.isFalse(yield* h.fs.exists(`${h.directory}/deployment-decision.json`));
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "does not reopen command admission when a release is replaced just after approval",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.request();
        yield* h.service.action({ id, action: "force" });
        yield* h.request(nextId);
        yield* h.service.reconcile;
        assert.isFalse(h.admission.enter());
        assert.equal((yield* h.service.state)?.status, "installing");
        assert.isFalse(h.admission.enter());
      }).pipe(Effect.provide(layer)),
  );
});
