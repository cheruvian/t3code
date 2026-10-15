import {
  ManagedDeploymentAction,
  ManagedDeploymentError,
  ManagedDeploymentRequest,
  type ManagedDeploymentState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as DeploymentAdmission from "./DeploymentAdmission.ts";

export class ManagedDeployment extends Context.Service<
  ManagedDeployment,
  {
    readonly reconcile: Effect.Effect<void, ManagedDeploymentError>;
    readonly state: Effect.Effect<ManagedDeploymentState, ManagedDeploymentError>;
    readonly changes: Stream.Stream<ManagedDeploymentState, ManagedDeploymentError>;
    readonly action: (
      input: typeof ManagedDeploymentAction.Type,
    ) => Effect.Effect<void, ManagedDeploymentError>;
  }
>()("t3/cloud/ManagedDeployment") {}

const isManagedDeploymentError = Schema.is(ManagedDeploymentError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const admission = yield* DeploymentAdmission.DeploymentAdmission;
  const lock = yield* Semaphore.make(1);
  const directory = path.join(config.baseDir, "runtime");
  const requestPath = path.join(directory, "deployment-request.json");
  const decisionPath = path.join(directory, "deployment-decision.json");
  const published = yield* SubscriptionRef.make<ManagedDeploymentState>(null);
  let approved: { id: string; at: number } | undefined;
  const readRequest = fs.readFileString(requestPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ManagedDeploymentRequest))),
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
  );
  const read = Effect.gen(function* () {
    const installing = yield* fs
      .readFileString(path.join(directory, "deployment-installing.json"))
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ManagedDeploymentRequest))),
        Effect.catchIf(
          (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
    const request = installing ?? (yield* readRequest);
    if (request === null) return null;
    const result = yield* fs
      .readFileString(path.join(directory, `deployment-result-${request.id}.json`))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                status: Schema.Literals(["installing", "failed", "succeeded", "cancelled"]),
              }),
            ),
          ),
        ),
        Effect.catchIf(
          (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
    if (result?.status !== "installing") {
      const decision = yield* fs.readFileString(decisionPath).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ id: Schema.String, action: Schema.String })),
          ),
        ),
        Effect.catchIf(
          (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      if (decision?.id === request.id && decision.action === "cancel") return null;
    }
    if (result?.status === "succeeded" || result?.status === "cancelled") return null;
    return { ...request, status: result?.status ?? request.status };
  });
  const activity = Effect.gen(function* () {
    const [row] = yield* sql<{ busyThreads: number; pendingEffects: number }>`
      SELECT
        (SELECT COUNT(DISTINCT thread_id) FROM (
          SELECT thread_id FROM orchestration_v2_projection_runs
            WHERE status IN ('preparing', 'starting', 'running', 'waiting', 'queued')
          UNION SELECT thread_id FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending'
          UNION SELECT thread_id FROM orchestration_v2_projection_provider_threads
            WHERE status = 'active' OR json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
          UNION SELECT thread_id FROM orchestration_v2_projection_turn_items
            WHERE type IN ('command_execution', 'dynamic_tool', 'subagent') AND status IN ('pending', 'running', 'waiting')
        )) AS busyThreads,
        (SELECT COUNT(*) FROM orchestration_v2_effect_outbox
          WHERE status IN ('pending', 'running')) AS pendingEffects
    `;
    return row ?? { busyThreads: 0, pendingEffects: 0 };
  });
  const encodeDecision = Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        id: Schema.String,
        action: Schema.Literals(["apply", "cancel"]),
        expiresAt: Schema.Number,
      }),
    ),
  );
  const writeDecision = (id: string, action: "apply" | "cancel") =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true });
      const temporary = `${decisionPath}.${process.pid}.tmp`;
      const encoded = yield* encodeDecision({
        id,
        action,
        expiresAt: (yield* Clock.currentTimeMillis) + 30_000,
      });
      yield* fs.writeFileString(temporary, encoded, { mode: 0o600 });
      yield* fs.rename(temporary, decisionPath);
    });
  const thaw = () => {
    admission.thaw();
    approved = undefined;
  };
  const state = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const request = yield* read;
        if (
          approved &&
          ((request?.id === approved.id && request.status === "failed") ||
            (request?.status !== "installing" && now - approved.at > 31_000))
        )
          thaw();
        if (request === null) return null;
        return {
          ...request,
          status:
            approved !== undefined && request.status === "queued"
              ? ("installing" as const)
              : request.status,
          ...(yield* activity),
        };
      }),
    )
    .pipe(Effect.mapError((cause) => new ManagedDeploymentError({ cause })));
  const check = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const request = yield* read;
        if (
          approved &&
          ((request?.id === approved.id && request.status === "failed") ||
            (request?.status !== "installing" && now - approved.at > 31_000))
        )
          thaw();
        if (request?.status === "installing") {
          admission.freeze(true);
          approved = { id: request.id, at: now };
          return;
        }
        if (request?.status !== "queued" || approved) return;
        const initial = yield* activity;
        if (initial.busyThreads > 0 || initial.pendingEffects > 0 || !admission.freeze(false))
          return;
        // Freeze admissions before the final read so a turn cannot slip between idle and handoff.
        const final = yield* activity;
        const latest = yield* read;
        if (final.busyThreads > 0 || final.pendingEffects > 0 || latest?.id !== request.id) {
          thaw();
          return;
        }
        yield* writeDecision(request.id, "apply");
        approved = { id: request.id, at: now };
      }),
    )
    .pipe(
      Effect.mapError((cause) => new ManagedDeploymentError({ cause })),
      Effect.onError(() => Effect.sync(thaw)),
    );
  const action = (input: typeof ManagedDeploymentAction.Type) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const request = yield* read;
          if (
            !request ||
            request.id !== input.id ||
            request.status === "installing" ||
            approved !== undefined
          )
            return yield* new ManagedDeploymentError();
          if (input.action === "cancel") {
            yield* writeDecision(request.id, "cancel");
            thaw();
          } else {
            admission.freeze(true);
            yield* writeDecision(request.id, "apply").pipe(Effect.onError(() => Effect.sync(thaw)));
            approved = { id: request.id, at: now };
          }
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isManagedDeploymentError(cause) ? cause : new ManagedDeploymentError({ cause }),
        ),
      );
  yield* ServerActivation.forkParked(
    check.pipe(
      Effect.andThen(state),
      Effect.flatMap((value) => SubscriptionRef.set(published, value)),
      Effect.catchCause((cause) => Effect.logWarning("Queued deployment check failed", { cause })),
      Effect.repeat(Schedule.spaced("2 seconds")),
    ),
  );
  return ManagedDeployment.of({
    reconcile: check,
    state,
    action,
    changes: SubscriptionRef.changes(published).pipe(
      Stream.changesWith(
        (a, b) =>
          a === b ||
          (a !== null &&
            b !== null &&
            a.id === b.id &&
            a.status === b.status &&
            a.busyThreads === b.busyThreads &&
            a.pendingEffects === b.pendingEffects),
      ),
    ),
  });
});
export const layer = Layer.effect(ManagedDeployment, make);
