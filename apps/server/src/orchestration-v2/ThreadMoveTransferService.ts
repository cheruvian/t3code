// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics schemaSyncInEffect:off
import * as NodeCrypto from "node:crypto";
import * as EffectPath from "effect/Path";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  ClaudeSettings,
  CodexSettings,
  CommandId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2DomainEventJson,
  ProjectId,
  ProviderInstanceId,
  ThreadMoveId,
  ThreadMovePortableManifest,
  ThreadMoveImportReceipt,
  ThreadMoveTransferError,
  type ThreadMoveRequest,
  type ThreadMoveResponse,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Projects from "../project/ProjectService.ts";
import * as RepositoryIdentity from "../project/RepositoryIdentityResolver.ts";
import * as Providers from "../provider/Services/ProviderRegistry.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import {
  signPayload,
  timingSafeEqualBase64Url,
  base64UrlEncode,
  base64UrlDecodeUtf8,
} from "../auth/utils.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  exportNativeSession,
  installNativeSession,
  nativeSessionDestinationPaths,
} from "../provider/Drivers/NativeSessionTransfer.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import {
  exportThreadWorkspace,
  restoreThreadWorkspace,
  fingerprintThreadWorkspace,
} from "./ThreadMovePortable.ts";
import {
  hashMoveFile,
  packMoveArchive,
  unpackMoveArchive,
  writeMoveJson,
} from "./ThreadMoveArchive.ts";
import { rehomeThreadMoveHistory } from "./ThreadMoveHistory.ts";
import {
  planMoveWorkspaceRecovery,
  saveMoveRecoveryJournal,
  readMoveRecoveryJournal,
  rollbackMoveJournal,
} from "./ThreadMoveRecovery.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Moves from "./ThreadMoveService.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Events from "./EventStore.ts";
import * as Sink from "./EventSink.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as Probe from "./NativeSessionResumeProbe.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as SetupScripts from "../project/ProjectSetupScriptRunner.ts";
import { readThreadMoveRepositoryHead } from "./ThreadMovePortable.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

const Part = Schema.Struct({
  payloadPath: Schema.String,
  sizeBytes: Schema.Number,
  sha256: Schema.String,
});
const Metadata = Schema.Struct({
  workspaceFingerprint: Schema.String,
  workspace: Schema.Struct({
    version: Schema.Literal(1),
    headCommit: Schema.String,
    stagedCommit: Schema.String,
    checkpointRefs: Schema.Array(Schema.String),
    gitBundle: Part,
    gitIndex: Part,
    workingTree: Part,
  }),
  native: Schema.Struct({
    version: Schema.Literal(1),
    driver: Schema.Literals(["codex", "claude"]),
    nativeThreadId: Schema.String,
    files: Schema.Array(
      Schema.Struct({ ...Part.fields, relativePath: Schema.String, mode: Schema.Number }),
    ),
  }),
  thread: OrchestrationV2AppThreadJson,
  providerThread: OrchestrationV2ProviderThreadJson,
  attachments: Schema.Array(
    Schema.Struct({
      payloadPath: Schema.String,
      attachmentId: Schema.String,
      relativePath: Schema.String,
    }),
  ),
});
const State = Schema.Struct({
  manifest: ThreadMovePortableManifest,
  sourceFingerprint: Schema.optional(Schema.String),
  exportSequence: Schema.optional(Schema.Number),
  undoAttempt: Schema.optional(Schema.String),
  phase: Schema.Literals(["fenced", "uploading", "activating", "committed", "cancelled", "moved"]),
  projectId: Schema.optional(ProjectId),
  instanceId: Schema.optional(ProviderInstanceId),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  receipt: Schema.optional(ThreadMoveImportReceipt),
  setupAttempted: Schema.optional(Schema.Boolean),
});
type State = typeof State.Type;
const encodeState = Schema.encodeSync(State),
  decodeState = Schema.decodeUnknownSync(State);
const Claims = Schema.Struct({
  moveId: ThreadMoveId,
  direction: Schema.Literals(["source", "destination"]),
  expiresAt: Schema.Number,
});
const decodeMoveId = Schema.decodeUnknownSync(ThreadMoveId);
const encodeClaims = Schema.encodeSync(Schema.fromJsonString(Claims));
const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(Claims));
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeMetadata = Schema.decodeUnknownSync(Metadata);
const encodeMetadata = Schema.encodeSync(Metadata);
const encodeEvent = Schema.encodeSync(OrchestrationV2DomainEventJson);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const encodeManifest = Schema.encodeSync(ThreadMovePortableManifest);
export const THREAD_MOVE_DATA_ROUTE = "/api/thread-moves";
const MAX_CHUNK_BYTES = 1024 * 1024;
const failure = (cause: unknown) => {
  let detail = cause;
  for (
    let depth = 0;
    depth < 5 &&
    typeof detail === "object" &&
    detail !== null &&
    "cause" in detail &&
    detail.cause !== undefined;
    depth++
  )
    detail = detail.cause;
  return new ThreadMoveTransferError({
    message: detail instanceof Error ? detail.message : String(detail),
  });
};
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });

export class ThreadMoveTransferService extends Context.Service<
  ThreadMoveTransferService,
  {
    readonly execute: (
      input: ThreadMoveRequest,
      projectScopeId?: ProjectId,
    ) => Effect.Effect<ThreadMoveResponse, ThreadMoveTransferError>;
    readonly readChunk: (
      token: string,
      offset: number,
    ) => Effect.Effect<Uint8Array, ThreadMoveTransferError>;
    readonly writeChunk: (
      token: string,
      offset: number,
      chunks: Stream.Stream<Uint8Array, ThreadMoveTransferError>,
    ) => Effect.Effect<number, ThreadMoveTransferError>;
  }
>()("t3/orchestration-v2/ThreadMoveTransferService") {}

export const layer = Layer.effect(
  ThreadMoveTransferService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const effectPath = yield* EffectPath.Path;
    const threads = yield* Threads.ThreadManagementService;
    const projections = yield* Projections.ProjectionStoreV2;
    const moves = yield* Moves.ThreadMoveService;
    const events = yield* Events.EventStoreV2;
    const sink = yield* Sink.EventSinkV2;
    const receipts = yield* Receipts.CommandReceiptStoreV2;
    const projects = yield* Projects.ProjectService;
    const repositories = yield* RepositoryIdentity.RepositoryIdentityResolver;
    const providers = yield* Providers.ProviderRegistry;
    const settings = yield* Settings.ServerSettingsService;
    const environment = yield* Environment.ServerEnvironmentIdentity;
    const secrets = yield* Secrets.ServerSecretStore;
    const probe = yield* Probe.NativeSessionResumeProbe;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const terminals = yield* TerminalManager.TerminalManager;
    const setupScripts = yield* SetupScripts.ProjectSetupScriptRunner;
    const lane = yield* makeKeyedSerialExecutor<string>();
    const root = NodePath.join(config.stateDir, "thread-moves");
    const directory = (direction: "source" | "destination", moveId: string) =>
      NodePath.join(root, `${direction}-${decodeMoveId(moveId)}`);
    const readState = (direction: "source" | "destination", moveId: string) =>
      io(async () => {
        try {
          return decodeState(
            JSON.parse(
              await NodeFSP.readFile(
                NodePath.join(directory(direction, moveId), "state.json"),
                "utf8",
              ),
            ),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      });
    const store = (direction: "source" | "destination", moveId: string, state: State) =>
      io(() =>
        writeMoveJson(
          NodePath.join(directory(direction, moveId), "state.json"),
          encodeState(state),
        ),
      );
    const readStates = (direction: "source" | "destination") =>
      io(async () => {
        const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        const states: State[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.startsWith(`${direction}-`)) continue;
          try {
            states.push(
              decodeState(
                JSON.parse(
                  await NodeFSP.readFile(NodePath.join(root, entry.name, "state.json"), "utf8"),
                ),
              ),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        return states;
      });
    const isMoveControlEvent = (type: string) =>
      type.startsWith("thread.move.") ||
      type === "thread.moved" ||
      type === "thread.settled" ||
      type === "thread.unsettled" ||
      type === "thread.visited" ||
      type === "thread.marked-unread";
    const hasMeaningfulEventsAfter = (threadId: ThreadId, sequence: number) =>
      events.read({ threadId, afterSequence: sequence }).pipe(
        Stream.filter(
          (stored) =>
            !isMoveControlEvent(stored.event.type) &&
            !/:(?:fence|activate|finalize|abort|restore)$/.test(String(stored.commandId)),
        ),
        Stream.runHead,
        Effect.map(Option.isSome),
      );
    const priorCopyIsUntouched = Effect.fn(function* (threadId: ThreadId) {
      const outgoing = (yield* readStates("source")).filter(
        (state) => state.manifest.threadId === threadId && state.phase === "moved",
      );
      for (const state of outgoing) {
        const finalized =
          state.exportSequence === undefined
            ? yield* receipts.getByCommandId(command(state.manifest.moveId, "finalize"))
            : Option.none();
        const sequence =
          state.exportSequence ??
          (Option.isSome(finalized) && finalized.value.status === "accepted"
            ? finalized.value.resultSequence
            : undefined);
        if (sequence !== undefined && !(yield* hasMeaningfulEventsAfter(threadId, sequence)))
          return true;
      }
      const incoming = (yield* readStates("destination")).filter(
        (state) =>
          state.manifest.threadId === threadId &&
          state.phase === "committed" &&
          state.receipt !== undefined,
      );
      for (const state of incoming) {
        const receipt = yield* receipts.getByCommandId(command(state.manifest.moveId, "import"));
        if (
          Option.isSome(receipt) &&
          receipt.value.status === "accepted" &&
          !(yield* hasMeaningfulEventsAfter(threadId, receipt.value.resultSequence))
        )
          return true;
      }
      return false;
    });
    const command = (moveId: string, action: string) =>
      CommandId.make(`thread-move:${moveId}:${action}`);
    const signedUrl = Effect.fn(function* (moveId: string, direction: "source" | "destination") {
      const secret = yield* secrets.getOrCreateRandom("thread-move-signing-key", 32);
      const payload = base64UrlEncode(
        encodeClaims({
          moveId,
          direction,
          expiresAt: (yield* Clock.currentTimeMillis) + 60 * 60 * 1000,
        }),
      );
      return `${THREAD_MOVE_DATA_ROUTE}/${payload}.${signPayload(payload, secret)}`;
    });
    const validateToken = Effect.fn(function* (token: string, direction: "source" | "destination") {
      const [payload, signature, extra] = token.split(".");
      const secret = yield* secrets.getOrCreateRandom("thread-move-signing-key", 32);
      if (
        !payload ||
        !signature ||
        extra ||
        !timingSafeEqualBase64Url(signature, signPayload(payload, secret))
      ) {
        return yield* failure("Invalid thread move URL.");
      }
      const claims = yield* decodeClaims(base64UrlDecodeUtf8(payload)).pipe(
        Effect.mapError(failure),
      );
      if (claims.expiresAt < (yield* Clock.currentTimeMillis) || claims.direction !== direction)
        return yield* failure("Expired thread move URL.");
      return claims;
    });
    const nativeHome = Effect.fn(function* (
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
    ) {
      const current = yield* settings.getSettings;
      const instance = deriveProviderInstanceConfigMap(current)[instanceId];
      if (instance?.driver !== driver)
        return yield* failure("The selected provider is incompatible.");
      const env = mergeProviderInstanceEnvironment(instance.environment);
      if (driver === "claudeAgent") {
        const claude = decodeClaudeSettings(instance.config ?? {});
        return {
          homePath: yield* resolveClaudeHomePath(claude, env).pipe(
            Effect.provideService(EffectPath.Path, effectPath),
          ),
          projectDirectoryName: env.CLAUDE_CODE_PROJECT_DIR_NAME,
        };
      }
      const codex = decodeCodexSettings(instance.config ?? {});
      const layout = yield* resolveCodexHomeLayout({
        ...codex,
        homePath: codex.homePath || env.CODEX_HOME || "",
      }).pipe(Effect.provideService(EffectPath.Path, effectPath));
      return { homePath: layout.sharedHomePath, projectDirectoryName: undefined };
    });
    const fingerprintSource = (cwd: string, dir: string) =>
      io(async () => {
        const temporary = await NodeFSP.mkdtemp(NodePath.join(dir, "fingerprint-"));
        try {
          return await fingerprintThreadWorkspace(cwd, temporary);
        } finally {
          await NodeFSP.rm(temporary, { recursive: true, force: true });
        }
      });
    const assertSourceFresh = Effect.fn(function* (state: State) {
      const dir = directory("source", state.manifest.moveId);
      const metadata = yield* io(async () =>
        decodeMetadata(
          JSON.parse(
            await NodeFSP.readFile(NodePath.join(dir, "payload", "metadata.json"), "utf8"),
          ),
        ),
      );
      if (
        !metadata.thread.worktreePath ||
        !state.sourceFingerprint ||
        (yield* fingerprintSource(metadata.thread.worktreePath, dir)) !== state.sourceFingerprint
      )
        return yield* failure(
          "The source worktree changed during the move. Reconcile its changes before finalizing.",
        );
      const home = yield* nativeHome(
        metadata.providerThread.providerInstanceId,
        metadata.providerThread.driver,
      );
      const temporary = yield* io(() => NodeFSP.mkdtemp(NodePath.join(dir, "native-check-")));
      const current = yield* io(() =>
        exportNativeSession({
          driver: metadata.native.driver,
          nativeThreadId: metadata.native.nativeThreadId,
          sourceHomePath: home.homePath,
          sourceCwd: metadata.thread.worktreePath!,
          payloadDirectory: temporary,
          ...(home.projectDirectoryName === undefined
            ? {}
            : { claudeProjectDirectoryName: home.projectDirectoryName }),
        }),
      ).pipe(
        Effect.ensuring(
          io(() => NodeFSP.rm(temporary, { recursive: true, force: true })).pipe(Effect.orDie),
        ),
      );
      if (
        current.files.length !== metadata.native.files.length ||
        current.files.some(
          (file, index) =>
            file.relativePath !== metadata.native.files[index]?.relativePath ||
            file.sha256 !== metadata.native.files[index]?.sha256,
        )
      )
        return yield* failure(
          "The source native session changed during the move. Reconcile it before finalizing.",
        );
    });
    const recoveredReceipt = Effect.fn(function* (state: State) {
      if (state.phase === "cancelled") return undefined;
      if (state.receipt) return state.receipt;
      const existing = yield* receipts.getByCommandId(command(state.manifest.moveId, "import"));
      if (Option.isNone(existing) || existing.value.status !== "accepted") return undefined;
      return {
        version: 1 as const,
        importId: state.manifest.moveId,
        moveId: state.manifest.moveId,
        threadId: state.manifest.threadId,
        destinationEnvironmentId: state.manifest.destinationEnvironmentId,
        providerDriver: state.manifest.providerDriver,
        nativeThreadId: state.manifest.nativeThreadId,
        activatedAt: DateTime.formatIso(existing.value.acceptedAt),
        manifestSha256: awaitManifestHash(state.manifest),
      };
    });
    const exportThread = Effect.fn(function* (
      input: Extract<ThreadMoveRequest, { action: "export" }>,
    ) {
      const existing = yield* readState("source", input.moveId);
      if (existing) {
        if (
          existing.manifest.threadId !== input.threadId ||
          existing.manifest.destinationEnvironmentId !== input.destinationEnvironmentId
        )
          return yield* failure("Move identity was reused.");
        return {
          state: existing.phase,
          manifest: existing.manifest,
          relativeUrl: yield* signedUrl(input.moveId, "source"),
        };
      }
      yield* moves.fence({ commandId: command(input.moveId, "fence"), ...input });
      return yield* Effect.gen(function* () {
        const projection = yield* threads.getThreadProjection(input.threadId);
        const project = yield* projects.getById(projection.thread.projectId);
        if (Option.isNone(project)) return yield* failure("The source project does not exist.");
        const cwd = projection.thread.worktreePath;
        if (!cwd) return yield* failure("Move requires a dedicated Git worktree.");
        const repository = yield* repositories.resolve(project.value.workspaceRoot, {
          refresh: true,
        });
        if (!repository) return yield* failure("The source repository needs a Git remote.");
        const providerThread =
          projection.providerThreads.find(
            (p) => p.id === projection.thread.activeProviderThreadId,
          ) ?? projection.providerThreads.at(-1);
        if (
          !providerThread ||
          (providerThread.driver !== "codex" && providerThread.driver !== "claudeAgent") ||
          !providerThread.nativeThreadRef?.nativeId
        )
          return yield* failure("The source native session is not portable.");
        if (
          projection.checkpointScopes.some(
            (scope) => NodePath.resolve(scope.cwd) !== NodePath.resolve(cwd),
          )
        )
          return yield* failure("Checkpoint workspaces outside this worktree cannot move.");
        const dir = directory("source", input.moveId),
          payload = NodePath.join(dir, "payload");
        yield* io(async () => {
          await NodeFSP.rm(dir, { recursive: true, force: true });
          await NodeFSP.mkdir(payload, { recursive: true, mode: 0o700 });
        });
        const checkpointRefs = projection.checkpoints.flatMap((checkpoint) =>
          checkpoint.status === "ready" ? [checkpoint.ref] : [],
        );
        const sourceFingerprint = yield* fingerprintSource(cwd, dir);
        const workspace = yield* io(() =>
          exportThreadWorkspace({
            cwd,
            payloadDirectory: payload,
            checkpointRefs,
            ...(input.destinationHeadCommit
              ? { destinationHeadCommit: input.destinationHeadCommit }
              : {}),
          }),
        );
        const home = yield* nativeHome(providerThread.providerInstanceId, providerThread.driver);
        const native = yield* io(() =>
          exportNativeSession({
            driver: providerThread.driver === "codex" ? "codex" : "claude",
            nativeThreadId: providerThread.nativeThreadRef!.nativeId!,
            sourceHomePath: home.homePath,
            sourceCwd: cwd,
            payloadDirectory: payload,
            ...(home.projectDirectoryName === undefined
              ? {}
              : { claudeProjectDirectoryName: home.projectDirectoryName }),
          }),
        );
        const attachmentIds = [
          ...new Set(
            projection.messages.flatMap((message) =>
              message.attachments.map((attachment) => attachment.id),
            ),
          ),
        ];
        const attachments: Array<{
          attachmentId: string;
          payloadPath: string;
          relativePath: string;
        }> = [];
        for (const [index, attachmentId] of attachmentIds.entries()) {
          const source = resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId,
          });
          if (!source) return yield* failure("An attachment cannot be resolved.");
          const payloadPath = `attachment-${index}.bin`;
          yield* io(() =>
            NodeFSP.copyFile(
              source,
              NodePath.join(payload, payloadPath),
              NodeFS.constants.COPYFILE_EXCL,
            ),
          );
          attachments.push({ attachmentId, payloadPath, relativePath: NodePath.basename(source) });
        }
        const history = yield* io(() =>
          NodeFSP.open(NodePath.join(payload, "history.jsonl"), "wx", 0o600),
        );
        yield* events.read({ threadId: input.threadId }).pipe(
          Stream.runForEach((stored) =>
            io(async () => {
              await history.writeFile(JSON.stringify(encodeEvent(stored.event)) + "\n");
            }),
          ),
          Effect.ensuring(io(() => history.close()).pipe(Effect.orDie)),
        );
        yield* io(() =>
          writeMoveJson(
            NodePath.join(payload, "metadata.json"),
            encodeMetadata({
              workspaceFingerprint: sourceFingerprint,
              workspace,
              native,
              thread: projection.thread,
              providerThread,
              attachments,
            }),
          ),
        );
        if (
          (yield* io(
            async () => (await NodeFSP.stat(NodePath.join(payload, "history.jsonl"))).size,
          )) >
          64 * 1024 * 1024
        )
          return yield* failure("Thread history exceeds the 64 MB import limit.");
        const archive = NodePath.join(dir, "archive.bin");
        yield* io(() => packMoveArchive(payload, archive));
        const sizeBytes = yield* io(async () => (await NodeFSP.stat(archive)).size);
        const sha256 = yield* io(() => hashMoveFile(archive));
        const manifest: ThreadMovePortableManifest = {
          version: 1,
          moveId: input.moveId,
          threadId: input.threadId,
          sourceEnvironmentId: yield* environment.getEnvironmentId,
          destinationEnvironmentId: input.destinationEnvironmentId,
          repositoryCanonicalKey: repository.canonicalKey,
          providerDriver: providerThread.driver,
          nativeThreadId: native.nativeThreadId,
          worktreeRelativePath: NodePath.basename(cwd),
          branch: projection.thread.branch,
          headCommit: workspace.headCommit,
          ignoredFilesIncluded: false,
          parts: [{ kind: "working_tree", sizeBytes, sha256 }],
        };
        if ((yield* fingerprintSource(cwd, dir)) !== sourceFingerprint)
          return yield* failure("The worktree changed while it was exported.");
        yield* store("source", input.moveId, {
          manifest,
          phase: "fenced",
          sourceFingerprint,
          exportSequence: yield* events.latestSequence({ threadId: input.threadId }),
        });
        return {
          state: "fenced" as const,
          manifest,
          relativeUrl: yield* signedUrl(input.moveId, "source"),
        };
      }).pipe(
        Effect.catchCause((cause) =>
          moves
            .abort({
              commandId: command(input.moveId, "export-failed"),
              threadId: input.threadId,
              moveId: input.moveId,
            })
            .pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
        ),
      );
    });
    const execute = Effect.fn(function* (input: ThreadMoveRequest) {
      if (input.action === "export") return yield* exportThread(input);
      const localId = yield* environment.getEnvironmentId;
      if (input.action === "begin") {
        if (
          input.manifest.moveId !== input.moveId ||
          input.manifest.threadId !== input.threadId ||
          input.manifest.destinationEnvironmentId !== localId ||
          input.manifest.sourceEnvironmentId === localId
        )
          return yield* failure("Move manifest does not match this destination.");
        const existing = yield* readState("destination", input.moveId);
        if (
          existing &&
          (awaitManifestHash(existing.manifest) !== awaitManifestHash(input.manifest) ||
            existing.projectId !== input.projectId ||
            existing.instanceId !== input.instanceId ||
            existing.branch !== input.branch)
        )
          return yield* failure("Move identity was reused with different destination settings.");
        if (!existing) {
          const project = yield* projects.getById(input.projectId);
          if (Option.isNone(project))
            return yield* failure("The destination project does not exist.");
          const repository = yield* repositories.resolve(project.value.workspaceRoot, {
            refresh: true,
          });
          if (repository?.canonicalKey !== input.manifest.repositoryCanonicalKey)
            return yield* failure("Choose the same repository on the destination.");
          const selected = (yield* providers.getProviders).find(
            (p) => p.instanceId === input.instanceId,
          );
          if (
            !selected?.enabled ||
            !selected.installed ||
            selected.auth.status !== "authenticated" ||
            selected.driver !== input.manifest.providerDriver
          )
            return yield* failure("Choose an installed, authenticated provider of the same kind.");
          yield* io(() =>
            NodeFSP.mkdir(directory("destination", input.moveId), { recursive: true, mode: 0o700 }),
          );
          yield* store("destination", input.moveId, {
            manifest: input.manifest,
            phase: "uploading",
            projectId: input.projectId,
            instanceId: input.instanceId,
            branch: input.branch,
          });
        }
        const state = existing ?? (yield* readState("destination", input.moveId))!;
        const receipt = yield* recoveredReceipt(state);
        const offset = yield* io(async () =>
          NodeFSP.stat(NodePath.join(directory("destination", input.moveId), "archive.bin")).then(
            (s) => s.size,
            () => 0,
          ),
        );
        return {
          state: receipt ? ("committed" as const) : state.phase,
          offset,
          ...(receipt ? { receipt } : {}),
          relativeUrl: yield* signedUrl(input.moveId, "destination"),
        };
      }
      let destination = yield* readState("destination", input.moveId);
      if (destination) {
        if (destination.manifest.threadId !== input.threadId)
          return yield* failure("Move thread identity does not match.");
        const receipt = yield* recoveredReceipt(destination);
        if (input.action === "undo") return yield* undoImport(destination, receipt);
        if (receipt) return { state: "committed" as const, receipt };
        if (destination.phase === "activating") {
          const existingThread = yield* projections
            .getThread(input.threadId)
            .pipe(
              Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(null)),
            );
          if (existingThread)
            return yield* failure(
              "Another import owns this thread; recovery requires reconciliation.",
            );
          const journal = yield* io(() =>
            readMoveRecoveryJournal(
              NodePath.join(directory("destination", input.moveId), "journal.json"),
            ),
          );
          if (!journal)
            return yield* failure(
              "The activation journal is unavailable; recovery requires reconciliation.",
            );
          yield* io(() => rollbackMoveJournal(journal));
          destination = { ...destination, phase: "cancelled" };
          yield* store("destination", input.moveId, destination);
        }
        if (input.action === "status" || destination.phase === "cancelled")
          return {
            state: destination.phase,
            ...(destination.phase === "cancelled"
              ? {
                  cancellation: {
                    moveId: input.moveId,
                    threadId: input.threadId,
                    destinationEnvironmentId: localId,
                    manifestSha256: awaitManifestHash(destination.manifest),
                  },
                }
              : {}),
          };
        if (input.action === "cancel") {
          if (destination.phase === "activating")
            return yield* failure(
              "Import activation is uncertain; reconcile it before cancellation.",
            );
          yield* store("destination", input.moveId, { ...destination, phase: "cancelled" });
          return {
            state: "cancelled" as const,
            cancellation: {
              moveId: input.moveId,
              threadId: input.threadId,
              destinationEnvironmentId: localId,
              manifestSha256: awaitManifestHash(destination.manifest),
            },
          };
        }
        if (input.action !== "commit") return yield* failure("Invalid destination move operation.");
        return yield* commitImport(destination);
      }
      const source = yield* readState("source", input.moveId);
      if (!source) {
        if ((yield* projections.getThreadShell(input.threadId)) === null)
          return { state: "idle" as const };
        const status = yield* moves.status({ threadId: input.threadId });
        if (status.state === "idle") return { state: "idle" as const };
        if (status.moveId !== input.moveId)
          return yield* failure("The thread belongs to a different move.");
        if (input.action === "status") return { state: status.state };
        if (input.action === "abort" && status.state === "fenced") {
          yield* moves.abort({
            commandId: command(input.moveId, "abort"),
            threadId: input.threadId,
            moveId: input.moveId,
          });
          return { state: (yield* moves.status({ threadId: input.threadId })).state };
        }
        return yield* failure(
          "The source move journal is unavailable; recovery requires reconciliation.",
        );
      }
      if (source.manifest.threadId !== input.threadId) return { state: "idle" as const };
      if (input.action === "status") {
        const status = yield* moves.status({ threadId: input.threadId });
        return {
          state: status.state,
          manifest: source.manifest,
          relativeUrl: yield* signedUrl(input.moveId, "source"),
        };
      }
      if (input.action === "activate") {
        yield* assertSourceFresh(source);
        yield* moves.prepareActivation({
          commandId: command(input.moveId, "activate"),
          threadId: input.threadId,
          moveId: input.moveId,
        });
        yield* store("source", input.moveId, { ...source, phase: "activating" });
        return { state: "activating" as const };
      }
      if (input.action === "prepareUndo") {
        const current = yield* projections.getThread(input.threadId);
        if (
          current.deletedAt !== null ||
          (source.phase !== "moved" &&
            !["moved", "activating"].includes(current.environmentMove?.status ?? ""))
        )
          return yield* failure("The retained source is not available for undo.");
        const metadata = yield* io(async () =>
          decodeMetadata(
            JSON.parse(
              await NodeFSP.readFile(
                NodePath.join(directory("source", input.moveId), "payload", "metadata.json"),
                "utf8",
              ),
            ),
          ),
        );
        yield* probe.probe({
          instanceId: metadata.providerThread.providerInstanceId,
          thread: metadata.thread,
          providerThread: metadata.providerThread,
        });
        return { state: "moved" as const };
      }
      if (input.action === "restore") {
        if (input.cancellation.manifestSha256 !== awaitManifestHash(source.manifest))
          return yield* failure("The undo belongs to a different move.");
        yield* moves.reclaim({
          commandId: command(input.moveId, "restore"),
          threadId: input.threadId,
          moveId: input.moveId,
          cancellation: input.cancellation,
        });
        yield* store("source", input.moveId, { ...source, phase: "cancelled" });
        return { state: "idle" as const };
      }
      if (input.action === "abort" || input.action === "recover") {
        if (
          input.action === "recover" &&
          input.cancellation.manifestSha256 !== awaitManifestHash(source.manifest)
        )
          return yield* failure("The cancellation belongs to a different archive.");
        yield* moves.abort({
          commandId: command(input.moveId, input.action),
          threadId: input.threadId,
          moveId: input.moveId,
          ...(input.action === "recover" ? { cancellation: input.cancellation } : {}),
        });
        yield* store("source", input.moveId, { ...source, phase: "cancelled" });
        return { state: "cancelled" as const };
      }
      if (input.action === "finalize") {
        const status = yield* moves.status({ threadId: input.threadId });
        const finalized = yield* receipts.getByCommandId(command(input.moveId, "finalize"));
        if (
          status.state !== "moved" &&
          !(Option.isSome(finalized) && finalized.value.status === "accepted")
        )
          yield* assertSourceFresh(source);
        if (input.receipt.manifestSha256 !== awaitManifestHash(source.manifest))
          return yield* failure("The receipt belongs to a different archive.");
        yield* moves.finalize({
          commandId: command(input.moveId, "finalize"),
          threadId: input.threadId,
          moveId: input.moveId,
          receipt: input.receipt,
        });
        yield* store("source", input.moveId, { ...source, phase: "moved", receipt: input.receipt });
        return { state: "moved" as const };
      }
      return yield* failure("Invalid source move operation.");
    });
    const undoImport = Effect.fn(function* (
      state: State,
      receipt: ThreadMoveImportReceipt | undefined,
    ) {
      const cancellation = {
        moveId: state.manifest.moveId,
        threadId: state.manifest.threadId,
        destinationEnvironmentId: state.manifest.destinationEnvironmentId,
        manifestSha256: awaitManifestHash(state.manifest),
      };
      if (state.phase === "cancelled") return { state: "cancelled" as const, cancellation };
      if (!receipt) return yield* failure("Only a completed move can be undone.");
      const undoId = state.undoAttempt ?? `undo-${yield* io(async () => NodeCrypto.randomUUID())}`;
      const current = yield* projections.getThread(state.manifest.threadId);
      if (
        current.environmentMove?.moveId === undoId &&
        current.environmentMove.status === "moved"
      ) {
        yield* store("destination", state.manifest.moveId, {
          ...state,
          phase: "cancelled",
          receipt: undefined,
          undoAttempt: undoId,
        });
        return { state: "cancelled" as const, cancellation };
      }
      yield* store("destination", state.manifest.moveId, { ...state, undoAttempt: undoId });
      if (current.environmentMove?.moveId !== undoId)
        yield* moves.fence({
          commandId: command(state.manifest.moveId, `undo-${undoId}-fence`),
          threadId: current.id,
          moveId: undoId,
          destinationEnvironmentId: state.manifest.sourceEnvironmentId,
        });
      return yield* Effect.gen(function* () {
        const imported = yield* receipts.getByCommandId(command(state.manifest.moveId, "import"));
        if (Option.isNone(imported)) return yield* failure("The import receipt is missing.");
        const changed = yield* events
          .read({ threadId: state.manifest.threadId, afterSequence: imported.value.resultSequence })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type !== "thread.visited" &&
                stored.event.type !== "thread.marked-unread" &&
                !String(stored.commandId).startsWith(`thread-move:${state.manifest.moveId}:undo-`),
            ),
            Stream.runCollect,
          );
        if (changed.length > 0)
          return yield* failure(
            "Undo is available before continuing or changing the destination thread. Its work is retained.",
          );
        const dir = directory("destination", state.manifest.moveId);
        const metadata = yield* io(async () =>
          decodeMetadata(
            JSON.parse(
              await NodeFSP.readFile(NodePath.join(dir, "payload", "metadata.json"), "utf8"),
            ),
          ),
        );
        if (
          !current.worktreePath ||
          (yield* fingerprintSource(current.worktreePath, dir)) !== metadata.workspaceFingerprint
        )
          return yield* failure("The destination worktree changed and cannot be undone.");
        const journal = yield* io(() =>
          readMoveRecoveryJournal(NodePath.join(dir, "journal.json")),
        );
        if (!journal) return yield* failure("The destination journal is missing.");
        for (const file of journal.files)
          if ((yield* io(() => hashMoveFile(file.path))) !== file.sha256)
            return yield* failure(
              "The destination session or attachment changed and cannot be undone.",
            );
        yield* moves.prepareActivation({
          commandId: command(state.manifest.moveId, `undo-${undoId}-activate`),
          threadId: current.id,
          moveId: undoId,
        });
        yield* moves.finalize({
          commandId: command(state.manifest.moveId, `undo-${undoId}-finalize`),
          threadId: current.id,
          moveId: undoId,
          receipt: {
            ...receipt,
            moveId: undoId,
            destinationEnvironmentId: state.manifest.sourceEnvironmentId,
          },
        });
        yield* store("destination", state.manifest.moveId, {
          ...state,
          phase: "cancelled",
          receipt: undefined,
          undoAttempt: undoId,
        });
        return { state: "cancelled" as const, cancellation };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const status = yield* moves.status({ threadId: current.id });
            if (status.state === "fenced") {
              yield* moves.abort({
                commandId: command(state.manifest.moveId, `undo-${undoId}-abort`),
                threadId: current.id,
                moveId: undoId,
              });
              yield* store("destination", state.manifest.moveId, {
                ...state,
                undoAttempt: undefined,
              });
            }
            return yield* Effect.failCause(cause);
          }),
        ),
      );
    });
    const commitImport = Effect.fn(function* (state: State) {
      if (!state.projectId || !state.instanceId || state.branch === undefined)
        return yield* failure("Destination settings are missing.");
      const projectId = state.projectId;
      const instanceId = state.instanceId;
      const branch = state.branch;
      const dir = directory("destination", state.manifest.moveId),
        archive = NodePath.join(dir, "archive.bin"),
        payload = NodePath.join(dir, "payload");
      if (state.phase === "activating")
        return yield* failure(
          "Interrupted activation needs reconciliation; its source remains fenced.",
        );
      const part = state.manifest.parts[0];
      if (
        state.manifest.parts.length !== 1 ||
        !part ||
        (yield* io(async () => (await NodeFSP.stat(archive)).size)) !== part.sizeBytes ||
        (yield* io(() => hashMoveFile(archive))) !== part.sha256
      )
        return yield* failure("The move upload is incomplete or corrupt.");
      return yield* projects.withActiveProject(projectId, (project) =>
        threadCommands.withLock(
          state.manifest.threadId,
          Effect.gen(function* () {
            const repo = yield* repositories.resolve(project.workspaceRoot, { refresh: true });
            if (repo?.canonicalKey !== state.manifest.repositoryCanonicalKey)
              return yield* failure("Destination repository identity changed.");
            const selected = (yield* providers.getProviders).find(
              (provider) => provider.instanceId === instanceId,
            );
            if (
              !selected?.enabled ||
              !selected.installed ||
              selected.auth.status !== "authenticated" ||
              selected.driver !== state.manifest.providerDriver
            )
              return yield* failure(
                "Destination provider is no longer compatible and authenticated.",
              );
            const existing = yield* projections
              .getThread(state.manifest.threadId)
              .pipe(
                Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(null)),
              );
            let replaceCheckpointRefs: ReadonlyArray<string> | undefined;
            if (existing) {
              const projection = yield* projections.getThreadRecords(state.manifest.threadId, [
                "runs",
                "providerThreads",
                "providerTurns",
                "runtimeRequests",
                "subagents",
                "contextTransfers",
                "checkpoints",
              ]);
              const activeProviderThread =
                projection.providerThreads.find(
                  (candidate) => candidate.id === existing.activeProviderThreadId,
                ) ?? projection.providerThreads.at(-1);
              const hasActiveWork =
                projection.runs.some((run) =>
                  ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
                ) ||
                projection.providerTurns.some((turn) => turn.status === "running") ||
                projection.runtimeRequests.some((request) => request.status === "pending") ||
                projection.providerThreads.some(
                  (providerThread) => (providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
                ) ||
                projection.subagents.some((subagent) => subagent.status === "running") ||
                projection.contextTransfers.some((transfer) => transfer.status === "pending") ||
                (yield* effectOutbox.hasUnsettledForThread(existing.id)) ||
                (yield* terminals.hasOpenForThread(existing.id));
              if (hasActiveWork)
                return yield* failure(
                  "The destination thread has active or pending work and cannot be updated.",
                );
              if (
                existing.deletedAt !== null ||
                activeProviderThread?.driver !== state.manifest.providerDriver ||
                activeProviderThread.nativeThreadRef?.nativeId !== state.manifest.nativeThreadId ||
                !(yield* priorCopyIsUntouched(existing.id))
              )
                return yield* failure(
                  "Move conflict: the destination thread has divergent work and cannot be updated automatically.",
                );
              replaceCheckpointRefs = projection.checkpoints.map((checkpoint) => checkpoint.ref);
            }
            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* io(async () => {
                  await NodeFSP.rm(payload, { recursive: true, force: true });
                  await unpackMoveArchive(archive, payload);
                });
                const metadata = yield* io(async () =>
                  decodeMetadata(
                    JSON.parse(
                      await NodeFSP.readFile(NodePath.join(payload, "metadata.json"), "utf8"),
                    ),
                  ),
                );
                if (
                  metadata.thread.id !== state.manifest.threadId ||
                  metadata.native.nativeThreadId !== state.manifest.nativeThreadId ||
                  metadata.workspace.headCommit !== state.manifest.headCommit ||
                  metadata.providerThread.driver !== state.manifest.providerDriver ||
                  metadata.providerThread.nativeThreadRef?.nativeId !==
                    state.manifest.nativeThreadId
                )
                  return yield* failure("The archive content does not match its manifest.");
                const driver = state.manifest.providerDriver;
                if (driver !== "codex" && driver !== "claudeAgent")
                  return yield* failure("This provider cannot move.");
                const home = yield* nativeHome(instanceId, driver);
                const cwd = NodePath.join(config.worktreesDir, `moved-${state.manifest.moveId}`);
                const thread = {
                  ...metadata.thread,
                  projectId,
                  worktreePath: cwd,
                  branch,
                  providerInstanceId: instanceId,
                  modelSelection: {
                    ...metadata.thread.modelSelection,
                    instanceId,
                  },
                  environmentMove: null,
                  settledOverride: null,
                  settledAt: null,
                  unsettledAt: null,
                  archivedAt: null,
                };
                const restoreInput = {
                  repositoryRoot: project.workspaceRoot,
                  targetWorktreePath: cwd,
                  branch,
                  payloadDirectory: payload,
                  descriptor: metadata.workspace,
                  importKey: state.manifest.moveId,
                  workspaceFingerprint: metadata.workspaceFingerprint,
                  ...(replaceCheckpointRefs === undefined ? {} : { replaceCheckpointRefs }),
                };
                let journal = yield* io(() => planMoveWorkspaceRecovery(restoreInput));
                const journalPath = NodePath.join(dir, "journal.json");
                yield* io(() => saveMoveRecoveryJournal(journalPath, journal));
                yield* store("destination", state.manifest.moveId, {
                  ...state,
                  phase: "activating",
                });
                const workspace = yield* io(() => restoreThreadWorkspace(restoreInput));
                let nativeRollback: (() => Promise<void>) | undefined;
                const installedAttachments: Array<{
                  readonly target: string;
                  readonly replacement?: string;
                }> = [];
                const activatedAt = yield* DateTime.now;
                const receipt: ThreadMoveImportReceipt = {
                  version: 1,
                  importId: state.manifest.moveId,
                  moveId: state.manifest.moveId,
                  threadId: thread.id,
                  destinationEnvironmentId: state.manifest.destinationEnvironmentId,
                  providerDriver: driver,
                  nativeThreadId: state.manifest.nativeThreadId,
                  activatedAt: DateTime.formatIso(activatedAt),
                  manifestSha256: awaitManifestHash(state.manifest),
                };
                const result = yield* Effect.gen(function* () {
                  const installInput = {
                    archive: metadata.native,
                    payloadDirectory: payload,
                    destinationHomePath: home.homePath,
                    destinationCwd: cwd,
                    ...(home.projectDirectoryName === undefined
                      ? {}
                      : { claudeProjectDirectoryName: home.projectDirectoryName }),
                    ...(existing === null
                      ? {}
                      : {
                          replacementDirectory: NodePath.join(dir, "replaced", "native-session"),
                        }),
                  };
                  const nativePaths = yield* io(() => nativeSessionDestinationPaths(installInput));
                  yield* io(async () => {
                    const nativeFiles = [];
                    for (const [index, target] of nativePaths.entries()) {
                      const exists = await NodeFSP.lstat(target).then(
                        () => true,
                        (error) => {
                          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                          throw error;
                        },
                      );
                      if (exists && existing === null)
                        throw new Error("The destination native session already exists.");
                      const previousPath = exists
                        ? NodePath.join(
                            dir,
                            "replaced",
                            "native-session",
                            `${metadata.native.files[index]!.payloadPath}.previous`,
                          )
                        : undefined;
                      nativeFiles.push({
                        path: target,
                        sha256: metadata.native.files[index]!.sha256,
                        ...(previousPath === undefined
                          ? {}
                          : { previousPath, previousSha256: await hashMoveFile(target) }),
                      });
                    }
                    journal = {
                      ...journal,
                      files: nativeFiles,
                    };
                    await saveMoveRecoveryJournal(journalPath, journal);
                  });
                  nativeRollback = yield* io(() => installNativeSession(installInput));
                  const resumed = yield* probe.probe({
                    instanceId,
                    thread,
                    providerThread: {
                      ...metadata.providerThread,
                      providerInstanceId: instanceId,
                      providerSessionId: null,
                    },
                  });
                  for (const attachment of metadata.attachments) {
                    const target = NodePath.join(config.attachmentsDir, attachment.relativePath);
                    if (
                      NodePath.basename(attachment.relativePath) !== attachment.relativePath ||
                      !attachment.relativePath.startsWith(`${attachment.attachmentId}.`) ||
                      !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(attachment.relativePath) ||
                      !/^attachment-\d+\.bin$/.test(attachment.payloadPath)
                    )
                      return yield* failure("Invalid attachment archive.");
                    const replacedAttachment = yield* io(async () => {
                      await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
                      const exists = await NodeFSP.lstat(target).then(
                        () => true,
                        (error) => {
                          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                          throw error;
                        },
                      );
                      const replacement = NodePath.join(
                        dir,
                        "replaced",
                        "attachments",
                        attachment.relativePath,
                      );
                      if (exists && existing === null)
                        throw new Error("The destination attachment already exists.");
                      const previousSha256 = exists ? await hashMoveFile(target) : undefined;
                      journal = {
                        ...journal,
                        files: [
                          ...journal.files,
                          {
                            path: target,
                            sha256: await hashMoveFile(
                              NodePath.join(payload, attachment.payloadPath),
                            ),
                            ...(exists ? { previousPath: replacement, previousSha256 } : {}),
                          },
                        ],
                      };
                      await saveMoveRecoveryJournal(journalPath, journal);
                      if (exists) {
                        await NodeFSP.mkdir(NodePath.dirname(replacement), {
                          recursive: true,
                          mode: 0o700,
                        });
                        await NodeFSP.rename(target, replacement);
                      }
                      try {
                        await NodeFSP.copyFile(
                          NodePath.join(payload, attachment.payloadPath),
                          target,
                          NodeFS.constants.COPYFILE_EXCL,
                        );
                      } catch (error) {
                        await NodeFSP.rm(target, { force: true });
                        if (exists) await NodeFSP.rename(replacement, target);
                        throw error;
                      }
                      return exists ? replacement : undefined;
                    });
                    installedAttachments.push({
                      target,
                      ...(replacedAttachment === undefined
                        ? {}
                        : { replacement: replacedAttachment }),
                    });
                  }
                  const historyPath = NodePath.join(payload, "history.jsonl");
                  const historySize = yield* io(async () => (await NodeFSP.stat(historyPath)).size);
                  if (historySize > 64 * 1024 * 1024)
                    return yield* failure("Thread history exceeds the 64 MB import limit.");
                  const history = yield* io(async () =>
                    (await NodeFSP.readFile(historyPath, "utf8"))
                      .split("\n")
                      .filter(Boolean)
                      .map((line) => decodeEvent(JSON.parse(line))),
                  );
                  yield* io(async () => {
                    journal = {
                      ...journal,
                      files: await Promise.all(
                        journal.files.map(async (file) => ({
                          ...file,
                          sha256: await hashMoveFile(file.path),
                        })),
                      ),
                    };
                    await saveMoveRecoveryJournal(journalPath, journal);
                  });
                  if (
                    history.some((event) => event.threadId !== thread.id) ||
                    history[0]?.type !== "thread.created"
                  )
                    return yield* failure("Invalid thread history.");
                  const imported = rehomeThreadMoveHistory(history, {
                    sourceInstanceId: metadata.providerThread.providerInstanceId,
                    moveId: state.manifest.moveId,
                    sourceEnvironmentId: state.manifest.sourceEnvironmentId,
                    projectId,
                    instanceId,
                    cwd,
                    branch,
                    providerThread: resumed,
                  });
                  yield* sink.commitCommand({
                    commandId: command(state.manifest.moveId, "import"),
                    threadId: thread.id,
                    commandType: "thread.environment-import",
                    acceptedAt: activatedAt,
                    events: imported,
                    effects: [],
                  });
                  yield* store("destination", state.manifest.moveId, {
                    ...state,
                    phase: "committed",
                    receipt,
                  });
                  return { state: "committed" as const, receipt };
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.gen(function* () {
                      // A transaction may have committed before publication or the journal write failed.
                      const committed = yield* recoveredReceipt(state);
                      if (committed) return { state: "committed" as const, receipt: committed };
                      yield* io(async () => {
                        for (const attachment of installedAttachments.toReversed()) {
                          await NodeFSP.rm(attachment.target, { force: true });
                          if (attachment.replacement !== undefined)
                            await NodeFSP.rename(attachment.replacement, attachment.target);
                        }
                        if (nativeRollback) await nativeRollback();
                        await workspace.rollback();
                      });
                      yield* store("destination", state.manifest.moveId, {
                        ...state,
                        phase: "cancelled",
                      });
                      return yield* Effect.failCause(cause);
                    }),
                  ),
                );
                return result;
              }),
            );
          }),
        ),
      );
    });
    return ThreadMoveTransferService.of({
      execute: (input, projectScopeId) =>
        lane
          .withLock(
            `thread:${input.threadId}`,
            lane.withLock(
              input.moveId,
              Effect.gen(function* () {
                if (projectScopeId) {
                  if (input.action === "begin" || (input.action === "status" && input.projectId)) {
                    if (input.projectId !== projectScopeId)
                      return yield* failure("The move is outside the calling project.");
                  } else {
                    const destination = yield* readState("destination", input.moveId);
                    if (destination) {
                      if (destination.projectId !== projectScopeId)
                        return yield* failure("The move is outside the calling project.");
                    } else {
                      const thread = yield* threads.getThreadShell(input.threadId);
                      if (!thread || thread.projectId !== projectScopeId)
                        return yield* failure("The move is outside the calling project.");
                    }
                  }
                }
                const result: ThreadMoveResponse = yield* execute(input);
                if (input.action === "status" && input.projectId) {
                  const project = yield* projects.getById(input.projectId);
                  if (Option.isSome(project) && project.value.deletedAt === null) {
                    const repositoryHeadCommit = yield* io(() =>
                      readThreadMoveRepositoryHead(project.value.workspaceRoot),
                    );
                    if (repositoryHeadCommit) return { ...result, repositoryHeadCommit };
                  }
                }
                if (input.action === "commit" && result.receipt) {
                  const state = yield* readState("destination", input.moveId);
                  if (state && !state.setupAttempted && state.projectId) {
                    yield* store("destination", input.moveId, { ...state, setupAttempted: true });
                    const thread = yield* projections.getThread(input.threadId);
                    const worktreePath = thread.worktreePath;
                    const projectId = state.projectId;
                    if (worktreePath)
                      yield* Effect.gen(function* () {
                        const setup = yield* setupScripts.runForThread({
                          threadId: input.threadId,
                          projectId,
                          worktreePath,
                          preferredTerminalId: `setup-move-${input.moveId}`,
                          observeCompletion: {},
                        });
                        if (setup.status === "started" && !setup.async && setup.completion) {
                          const completion = yield* setup.completion;
                          if (completion.exitCode !== 0)
                            yield* Effect.logWarning("Moved thread project setup failed", {
                              threadId: input.threadId,
                              exitCode: completion.exitCode,
                            });
                        }
                      }).pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning("Moved thread project setup could not start", {
                            threadId: input.threadId,
                            cause: Cause.squash(cause),
                          }),
                        ),
                      );
                  }
                }
                return result;
              }),
            ),
          )
          .pipe(Effect.catchCause((cause) => Effect.fail(failure(Cause.squash(cause))))),
      readChunk: (token, offset) =>
        Effect.gen(function* () {
          const claims = yield* validateToken(token, "source");
          if (!Number.isSafeInteger(offset) || offset < 0)
            return yield* failure("Invalid move offset.");
          return yield* io(async () => {
            const handle = await NodeFSP.open(
              NodePath.join(directory("source", claims.moveId), "archive.bin"),
              "r",
            );
            try {
              const buffer = Buffer.alloc(MAX_CHUNK_BYTES);
              const result = await handle.read(buffer, 0, buffer.length, offset);
              return buffer.subarray(0, result.bytesRead);
            } finally {
              await handle.close();
            }
          });
        }).pipe(Effect.mapError(failure)),
      writeChunk: (token, offset, chunks) =>
        Effect.gen(function* () {
          const claims = yield* validateToken(token, "destination");
          return yield* lane.withLock(
            claims.moveId,
            Effect.gen(function* () {
              const state = yield* readState("destination", claims.moveId);
              if (
                !state ||
                state.phase !== "uploading" ||
                !Number.isSafeInteger(offset) ||
                offset < 0
              )
                return yield* failure("This import cannot accept bytes.");
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const filePath = NodePath.join(
                    directory("destination", claims.moveId),
                    "archive.bin",
                  );
                  const handle = yield* io(() => NodeFSP.open(filePath, "a+", 0o600));
                  const size = yield* io(async () => (await handle.stat()).size);
                  if (size !== offset) {
                    yield* io(() => handle.close());
                    return yield* failure(`Resume upload at byte ${size}.`);
                  }
                  let written = 0;
                  yield* chunks.pipe(
                    Stream.runForEach((bytes) =>
                      io(async () => {
                        if (
                          written + bytes.byteLength > MAX_CHUNK_BYTES ||
                          offset + written + bytes.byteLength > state.manifest.parts[0]!.sizeBytes
                        )
                          throw new Error("Move chunk exceeds its declared size.");
                        await handle.writeFile(bytes);
                        written += bytes.byteLength;
                      }),
                    ),
                    Effect.andThen(io(() => handle.sync())),
                    Effect.onError(() => io(() => handle.truncate(offset)).pipe(Effect.orDie)),
                    Effect.ensuring(io(() => handle.close()).pipe(Effect.orDie)),
                  );
                  return offset + written;
                }),
              );
            }),
          );
        }).pipe(Effect.mapError(failure)),
    });
  }),
);

// The digest binds receipts to bounded metadata, including the archive's content hash.
function awaitManifestHash(manifest: ThreadMovePortableManifest): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(encodeManifest(manifest)))
    .digest("hex");
}
