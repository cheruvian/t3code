import {
  THREAD_MOVE_RPC,
  ThreadMoveTransferError,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
  type ThreadMoveRequest,
  type ThreadMoveResponse,
  type ServerConfig,
} from "@t3tools/contracts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Registry from "../connection/registry.ts";
import * as Supervisor from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";
import { resolveAssetUrl } from "../state/assets.ts";

export interface MoveThreadInput {
  readonly threadId: ThreadId;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly instanceId: ProviderInstanceId;
  readonly moveId?: string;
}
export interface UndoThreadMoveInput {
  readonly threadId: ThreadId;
  readonly moveId: string;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly destinationEnvironmentId: EnvironmentId;
}

export async function runThreadMoveUndoSaga(
  input: UndoThreadMoveInput,
  ports: Pick<ThreadMovePorts, "source" | "destination">,
) {
  const identity = { threadId: input.threadId, moveId: input.moveId };
  const source = await ports.source({ ...identity, action: "status" });
  const destination = await ports.destination({ ...identity, action: "status" });
  if (destination.cancellation) {
    if (source.state !== "idle")
      await ports.source({
        ...identity,
        action: "restore",
        cancellation: destination.cancellation,
      });
    return;
  }
  await ports.source({ ...identity, action: "prepareUndo" });
  const undone = await ports.destination({ ...identity, action: "undo" });
  if (!undone.cancellation) throw new Error("The destination has not confirmed undo.");
  await ports.source({ ...identity, action: "restore", cancellation: undone.cancellation });
}

export function threadMoveUndoParticipants(
  thread: import("../state/models.ts").EnvironmentThreadShell,
): UndoThreadMoveInput | null {
  if (
    thread.environmentMoveOrigin &&
    (!thread.environmentMove || thread.environmentMove.moveId.startsWith("undo-"))
  )
    return {
      threadId: thread.id,
      moveId: thread.environmentMoveOrigin.moveId,
      sourceEnvironmentId: thread.environmentMoveOrigin.sourceEnvironmentId,
      destinationEnvironmentId: thread.environmentId,
    };
  return thread.environmentMove?.status === "moved"
    ? {
        threadId: thread.id,
        moveId: thread.environmentMove.moveId,
        sourceEnvironmentId: thread.environmentId,
        destinationEnvironmentId: thread.environmentMove.destinationEnvironmentId,
      }
    : null;
}

export const undoThreadMove = Effect.fn("clientRuntime.undoThreadMove")(function* (
  input: UndoThreadMoveInput,
) {
  const registry = yield* Registry.EnvironmentRegistry;
  const context = yield* Effect.context<Registry.EnvironmentRegistry>();
  const execute = Effect.runPromiseWith(context);
  yield* Effect.tryPromise({
    try: (signal) => {
      const run: typeof execute = (effect, options) => execute(effect, { ...options, signal });
      return runThreadMoveUndoSaga(input, {
        source: (requestInput) =>
          run(registry.run(input.sourceEnvironmentId, request(THREAD_MOVE_RPC, requestInput))),
        destination: (requestInput) =>
          run(registry.run(input.destinationEnvironmentId, request(THREAD_MOVE_RPC, requestInput))),
      });
    },
    catch: (cause) =>
      new ThreadMoveTransferError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});
export interface ThreadMovePorts {
  readonly source: (input: ThreadMoveRequest) => Promise<ThreadMoveResponse>;
  readonly destination: (input: ThreadMoveRequest) => Promise<ThreadMoveResponse>;
  readonly transfer: (sourceUrl: string, destinationUrl: string, offset: number) => Promise<number>;
}
/** Client-mediated transfer; neither environment needs network access to the other. */
export async function runThreadMoveSaga(
  input: MoveThreadInput & { readonly moveId: string },
  ports: ThreadMovePorts,
): Promise<void> {
  const identity = { moveId: input.moveId, threadId: input.threadId };
  let activationPossible = false;
  try {
    const destination = await ports.destination({ ...identity, action: "status" });
    const source = await ports.source({
      ...identity,
      action: "export",
      destinationEnvironmentId: input.destinationEnvironmentId,
    });
    activationPossible = source.state === "activating" || source.state === "moved";
    if (destination.cancellation) {
      await ports.source({
        ...identity,
        action: "recover",
        cancellation: destination.cancellation,
      });
      throw new Error("The destination cancelled this move. The source is usable again.");
    }
    if (destination.receipt) {
      if (source.state === "fenced") await ports.source({ ...identity, action: "activate" });
      await ports.source({ ...identity, action: "finalize", receipt: destination.receipt });
      return;
    }
    if (!source.manifest || !source.relativeUrl)
      throw new Error("The source did not provide an archive.");
    const begin = await ports.destination({
      ...identity,
      action: "begin",
      manifest: source.manifest,
      projectId: input.projectId,
      instanceId: input.instanceId,
      branch: `moved/${input.moveId}`,
    });
    if (!begin.relativeUrl) throw new Error("The destination did not provide an upload URL.");
    let offset = begin.offset ?? 0;
    const size = source.manifest.parts[0]?.sizeBytes;
    if (size === undefined) throw new Error("The source archive has no size.");
    while (offset < size) {
      const next = await ports.transfer(source.relativeUrl, begin.relativeUrl, offset);
      if (next <= offset || next > size) throw new Error("Invalid upload progress.");
      offset = next;
    }
    // A lost activation acknowledgement is uncertain: preserve the source fence.
    activationPossible = true;
    await ports.source({ ...identity, action: "activate" });
    const committed = await ports.destination({ ...identity, action: "commit" });
    if (!committed.receipt) throw new Error("The destination has no durable import receipt.");
    await ports.source({ ...identity, action: "finalize", receipt: committed.receipt });
  } catch (error) {
    if (!activationPossible) {
      await ports.destination({ ...identity, action: "cancel" }).catch(() => null);
      await ports.source({ ...identity, action: "abort" }).catch(() => undefined);
    } else {
      const cancellation = await ports
        .destination({ ...identity, action: "cancel" })
        .catch(async () => ports.destination({ ...identity, action: "status" }).catch(() => null));
      if (cancellation?.cancellation)
        await ports
          .source({ ...identity, action: "recover", cancellation: cancellation.cancellation })
          .catch(() => undefined);
    }
    throw error;
  }
}

export function compatibleThreadMoveProvider(config: ServerConfig | undefined, driver: string) {
  return config?.environment.capabilities.threadEnvironmentMove === true
    ? config.providers.find(
        (provider) =>
          provider.driver === driver &&
          provider.enabled &&
          provider.installed &&
          provider.auth.status === "authenticated",
      )
    : undefined;
}

export function threadMoveDestinations(input: {
  readonly thread: import("../state/models.ts").EnvironmentThreadShell;
  readonly projects: ReadonlyArray<import("../state/models.ts").EnvironmentProject>;
  readonly configs: ReadonlyMap<EnvironmentId, ServerConfig>;
}) {
  const source = input.configs.get(input.thread.environmentId);
  if (
    !input.thread.worktreePath ||
    source?.environment.capabilities.threadEnvironmentMove !== true ||
    input.thread.environmentMove?.status === "moved"
  )
    return [];
  const driver = source.providers.find(
    (provider) => provider.instanceId === input.thread.providerInstanceId,
  )?.driver;
  if (driver !== "codex" && driver !== "claudeAgent") return [];
  const repository = input.projects.find(
    (project) =>
      project.environmentId === input.thread.environmentId && project.id === input.thread.projectId,
  )?.repositoryIdentity?.canonicalKey;
  if (!repository) return [];
  return input.projects.flatMap((project) => {
    if (
      project.environmentId === input.thread.environmentId ||
      project.repositoryIdentity?.canonicalKey !== repository ||
      (input.thread.environmentMove &&
        input.thread.environmentMove.destinationEnvironmentId !== project.environmentId)
    )
      return [];
    const config = input.configs.get(project.environmentId);
    const provider = compatibleThreadMoveProvider(config, driver);
    return provider
      ? [
          {
            environmentId: project.environmentId,
            projectId: project.id,
            instanceId: provider.instanceId,
            label: config!.environment.label,
          },
        ]
      : [];
  });
}

export const moveThread = Effect.fn("clientRuntime.moveThread")(function* (input: MoveThreadInput) {
  const source = yield* Supervisor.EnvironmentSupervisor;
  const registry = yield* Registry.EnvironmentRegistry;
  const context = yield* Effect.context<
    Registry.EnvironmentRegistry | Supervisor.EnvironmentSupervisor
  >();
  const execute = Effect.runPromiseWith(context);
  const crypto = yield* Crypto.Crypto;
  const moveId = input.moveId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const sourceEnvironmentId = source.target.environmentId;
  if (sourceEnvironmentId === input.destinationEnvironmentId)
    return yield* new ThreadMoveTransferError({
      message: "Choose a different destination environment.",
    });
  const resolveUrl = (environmentId: EnvironmentId, relativeUrl: string) =>
    registry.run(
      environmentId,
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* new ThreadMoveTransferError({
            message: "The environment is disconnected.",
          });
        return resolveAssetUrl(prepared.value.httpBaseUrl, relativeUrl);
      }),
    );
  yield* Effect.tryPromise({
    try: (signal) => {
      const run: typeof execute = (effect, options) => execute(effect, { ...options, signal });
      return runThreadMoveSaga(
        { ...input, moveId },
        {
          source: (requestInput) =>
            run(registry.run(sourceEnvironmentId, request(THREAD_MOVE_RPC, requestInput))),
          destination: (requestInput) =>
            run(
              registry.run(input.destinationEnvironmentId, request(THREAD_MOVE_RPC, requestInput)),
            ),
          transfer: async (sourceRelative, destinationRelative, offset) => {
            const [sourceUrl, destinationUrl] = await Promise.all([
              run(resolveUrl(sourceEnvironmentId, sourceRelative)),
              run(resolveUrl(input.destinationEnvironmentId, destinationRelative)),
            ]);
            if (!sourceUrl || !destinationUrl)
              throw new Error("The environment URL is unavailable.");
            return await run(
              Effect.scoped(
                Effect.gen(function* () {
                  const http = yield* HttpClient.HttpClient;
                  const response = yield* http.get(`${sourceUrl}?offset=${offset}`);
                  if (response.status !== 200)
                    return yield* new ThreadMoveTransferError({ message: yield* response.text });
                  const bytes = new Uint8Array(yield* response.arrayBuffer);
                  if (bytes.byteLength > 1024 * 1024)
                    return yield* new ThreadMoveTransferError({
                      message: "Move download exceeded the chunk limit.",
                    });
                  const uploaded = yield* http.execute(
                    HttpClientRequest.post(`${destinationUrl}?offset=${offset}`).pipe(
                      HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
                    ),
                  );
                  if (uploaded.status !== 200)
                    return yield* new ThreadMoveTransferError({ message: yield* uploaded.text });
                  return Number(yield* uploaded.text);
                }).pipe(Effect.provide(FetchHttpClient.layer)),
              ),
            );
          },
        },
      );
    },
    catch: (cause) =>
      new ThreadMoveTransferError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});
