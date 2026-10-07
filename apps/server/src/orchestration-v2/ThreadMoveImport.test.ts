// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { afterEach, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type Project,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Repositories from "../project/RepositoryIdentityResolver.ts";
import * as Providers from "../provider/Services/ProviderRegistry.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { validateClaudeNativeSession } from "../provider/Drivers/ClaudeNativeSessionLoader.ts";
import { encodeClaudeProjectPath } from "../provider/Drivers/NativeSessionTransfer.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Sink from "./EventSink.ts";
import * as Events from "./EventStore.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as Outbox from "./EffectOutbox.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Moves from "./ThreadMoveService.ts";
import * as Probe from "./NativeSessionResumeProbe.ts";
import * as Transfer from "./ThreadMoveTransferService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as SetupScripts from "../project/ProjectSetupScriptRunner.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationEventInfrastructureLayerLive,
} from "./runtimeLayer.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
const threadId = ThreadId.make("thread-move-fixture");
const providerId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");
const nativeId = "019fbbc1-b12c-7360-a685-28c181f0025f";
const timestamp = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { cwd })).stdout.trim();

async function fixture(options?: {
  readonly failDestinationProbe?: boolean;
  readonly failSetup?: boolean;
  readonly sourceHasTerminal?: boolean;
  readonly probeGate?: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}) {
  const setupCalls: Array<{ environmentId: string; cwd: string }> = [];
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-move-integration-")),
  );
  roots.push(root);
  const sourceRoot = NodePath.join(root, "source"),
    destinationRoot = NodePath.join(root, "destination"),
    cwd = NodePath.join(root, "source-worktree");
  await NodeFSP.mkdir(sourceRoot);
  await NodeFSP.mkdir(destinationRoot);
  await git(sourceRoot, "init", "-b", "main");
  await NodeFSP.writeFile(NodePath.join(sourceRoot, "code.txt"), "base\n");
  await git(sourceRoot, "add", ".");
  await git(
    sourceRoot,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "base",
  );
  await git(sourceRoot, "worktree", "add", "-b", "feature", cwd);
  await NodeFSP.writeFile(NodePath.join(cwd, "code.txt"), "staged\n");
  await git(cwd, "add", "code.txt");
  await NodeFSP.writeFile(NodePath.join(cwd, "code.txt"), "unstaged\n");
  await NodeFSP.writeFile(NodePath.join(cwd, "untracked.txt"), "untracked\n");
  await NodeFSP.writeFile(NodePath.join(cwd, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 17, 7));
  await git(destinationRoot, "init", "-b", "destination-root");
  const sourceHome = NodePath.join(root, "source-home"),
    destinationHome = NodePath.join(root, "destination-home");
  const transcriptDir = NodePath.join(sourceHome, "projects", encodeClaudeProjectPath(cwd));
  await NodeFSP.mkdir(transcriptDir, { recursive: true });
  const transcript =
    [
      {
        type: "user",
        uuid: "11111111-1111-4111-8111-111111111111",
        parentUuid: null,
        sessionId: nativeId,
        cwd,
        timestamp: DateTime.formatIso(timestamp),
        message: { role: "user", content: "original native question" },
      },
      {
        type: "assistant",
        uuid: "22222222-2222-4222-8222-222222222222",
        parentUuid: "11111111-1111-4111-8111-111111111111",
        sessionId: nativeId,
        cwd,
        timestamp: DateTime.formatIso(timestamp),
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "original native answer" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n";
  await NodeFSP.writeFile(NodePath.join(transcriptDir, `${nativeId}.jsonl`), transcript);
  const projectId = ProjectId.make("move-project");
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId,
    title: "Move fixture",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: providerId,
    modelSelection: { instanceId: providerId, model: "claude-sonnet-4-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: cwd,
    activeProviderThreadId: ProviderThreadId.make("provider-move-fixture"),
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: thread.activeProviderThreadId!,
    driver,
    providerInstanceId: providerId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const storedEvents: OrchestrationV2DomainEvent[] = [
    {
      id: EventId.make("move-fixture-created"),
      threadId,
      occurredAt: timestamp,
      type: "thread.created",
      payload: thread,
    },
    {
      id: EventId.make("move-fixture-provider"),
      threadId,
      occurredAt: timestamp,
      type: "provider-thread.updated",
      payload: providerThread,
    },
    {
      id: EventId.make("move-fixture-message"),
      threadId,
      occurredAt: timestamp,
      type: "message.updated",
      payload: {
        id: MessageId.make("move-original-message"),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Full T3 conversation",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  ];
  function runtime(environmentId: string, repositoryRoot: string, home: string) {
    const infrastructure = OrchestrationEventInfrastructureLayerLive;
    const eventStore = Events.layerFromOrchestrationEventStore.pipe(Layer.provide(infrastructure));
    const receiptStore = Receipts.layerFromApplicationReceipts.pipe(Layer.provide(infrastructure));
    const stores = Layer.mergeAll(
      OrchestrationV2EventSinkLayerLive,
      eventStore,
      receiptStore,
      Projections.layer,
      Outbox.layer,
    );
    const threads = Layer.unwrap(
      Effect.gen(function* () {
        const projections = yield* Projections.ProjectionStoreV2;
        return Layer.mock(Threads.ThreadManagementService)({
          getThreadProjection: (id) => projections.getThreadProjection(id).pipe(Effect.orDie),
          getThreadShell: (id) => projections.getThreadShell(id).pipe(Effect.orDie),
        });
      }),
    );
    // Lifecycle decisions have separate real-orchestrator tests; this fixture uses the real event sink for every transition.
    const moves = Layer.effect(
      Moves.ThreadMoveService,
      Effect.gen(function* () {
        const projections = yield* Projections.ProjectionStoreV2;
        const sink = yield* Sink.EventSinkV2;
        const update = (
          suffix: string,
          transform: (thread: OrchestrationV2AppThread) => OrchestrationV2AppThread,
          commandId: CommandId,
        ) =>
          Effect.gen(function* () {
            const current = yield* projections.getThread(threadId);
            yield* sink.write({
              commandId,
              events: [
                {
                  id: EventId.make(`move-fixture-${environmentId}-${suffix}-${commandId}`),
                  threadId,
                  occurredAt: timestamp,
                  type: "thread.metadata-updated",
                  payload: transform(current),
                },
              ],
            });
          }).pipe(Effect.orDie);
        return Moves.ThreadMoveService.of({
          fence: (input) =>
            update(
              "fence",
              (current) => ({
                ...current,
                environmentMove: {
                  moveId: input.moveId,
                  destinationEnvironmentId: input.destinationEnvironmentId,
                  fencedAt: timestamp,
                  status: "fenced",
                },
              }),
              input.commandId,
            ).pipe(Effect.as({ providerDriver: "claudeAgent" as const })),
          prepareActivation: (input) =>
            update(
              "activate",
              (current) => ({
                ...current,
                environmentMove: { ...current.environmentMove!, status: "activating" },
              }),
              input.commandId,
            ),
          finalize: (input) =>
            update(
              "finalize",
              (current) => ({
                ...current,
                archivedAt: null,
                settledOverride: "settled",
                settledAt: timestamp,
                environmentMove: null,
              }),
              input.commandId,
            ),
          reclaim: (input) =>
            update(
              "restore",
              (current) => ({
                ...current,
                environmentMove: null,
                archivedAt: null,
                settledOverride: "active",
                settledAt: null,
              }),
              input.commandId,
            ),
          abort: (input) =>
            update("abort", (current) => ({ ...current, environmentMove: null }), input.commandId),
          status: () =>
            projections.getThread(threadId).pipe(
              Effect.map((current) => ({
                state: current.environmentMove?.status ?? ("idle" as const),
                moveId: current.environmentMove?.moveId ?? null,
                destinationEnvironmentId: current.environmentMove?.destinationEnvironmentId ?? null,
              })),
              Effect.orDie,
            ),
        });
      }),
    );
    const projectService = Layer.unwrap(
      Effect.gen(function* () {
        const projectionStore = yield* Projections.ProjectionStoreV2;
        const projectLifecycle = yield* makeKeyedSerialExecutor<ProjectId>();
        const destinationProject = {
          id: projectId,
          workspaceRoot: repositoryRoot,
          deletedAt: null,
        } as unknown as Project;
        return Layer.mock(Projects.ProjectService)({
          getById: () => Effect.succeed(Option.some(destinationProject)),
          withActiveProject: (_projectId, use) =>
            projectLifecycle.withLock(projectId, use(destinationProject)),
          delete: (input) =>
            projectLifecycle.withLock(
              input.projectId,
              Effect.gen(function* () {
                const existing = yield* projectionStore.getThread(threadId).pipe(
                  Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(null)),
                  Effect.orDie,
                );
                if (existing) return yield* new Projects.ProjectNotEmptyError({ projectId });
                return {
                  ...destinationProject,
                  deletedAt: DateTime.formatIso(timestamp),
                };
              }),
            ),
        });
      }),
    ).pipe(Layer.provide(stores));
    const dependencies = Layer.mergeAll(
      Layer.effect(
        SetupScripts.ProjectSetupScriptRunner,
        Effect.gen(function* () {
          const projectionStore = yield* Projections.ProjectionStoreV2;
          return SetupScripts.ProjectSetupScriptRunner.of({
            runForThread: (input) =>
              Effect.gen(function* () {
                yield* projectionStore.getThread(threadId).pipe(Effect.orDie);
                setupCalls.push({ environmentId, cwd: input.worktreePath });
                if (options?.failSetup) return yield* Effect.die(new Error("fixture setup failed"));
                return { status: "no-script" as const };
              }),
          });
        }),
      ).pipe(Layer.provide(stores)),
      stores,
      threads.pipe(Layer.provide(stores)),
      moves.pipe(Layer.provide(stores)),
      ThreadCommandExecutor.layer,
      Layer.mock(TerminalManager.TerminalManager)({
        hasOpenForThread: () =>
          Effect.succeed(options?.sourceHasTerminal === true && environmentId === "source"),
      }),
      projectService,
      Layer.mock(Repositories.RepositoryIdentityResolver)({
        resolve: () =>
          Effect.succeed({
            canonicalKey: "example.com/org/repo",
            rootPath: repositoryRoot,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://example.com/org/repo.git",
            },
          }),
      }),
      Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.succeed([
          {
            instanceId: providerId,
            driver,
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
          } as ServerProvider,
        ]),
      }),
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)),
      }),
      Layer.mock(Secrets.ServerSecretStore)({
        getOrCreateRandom: () =>
          Effect.succeed(new Uint8Array(32).fill(environmentId === "source" ? 1 : 2)),
      }),
      Layer.succeed(Probe.NativeSessionResumeProbe, {
        probe: (input) =>
          options?.failDestinationProbe && environmentId === "destination"
            ? Effect.fail(
                new Probe.NativeSessionResumeProbeError({
                  instanceId: providerId,
                  threadId,
                  cause: "fixture native resume failure",
                }),
              )
            : (environmentId === "destination" && options?.probeGate
                ? Deferred.succeed(options.probeGate.entered, undefined).pipe(
                    Effect.andThen(Deferred.await(options.probeGate.release)),
                  )
                : Effect.void
              ).pipe(
                Effect.andThen(
                  validateClaudeNativeSession({
                    nativeThreadId: input.providerThread.nativeThreadRef!.nativeId!,
                    cwd: input.thread.worktreePath!,
                    environment: { ...process.env, CLAUDE_CONFIG_DIR: home },
                    entryPath: NodePath.resolve("apps/server/src/bin.ts"),
                  }),
                ),
                Effect.map(() => ({
                  ...input.providerThread,
                  providerSessionId: null,
                  status: "not_loaded" as const,
                })),
                Effect.mapError(
                  (cause) =>
                    new Probe.NativeSessionResumeProbeError({
                      instanceId: providerId,
                      threadId,
                      cause,
                    }),
                ),
              ),
      }),
    );
    // Two independently scoped servers must coexist during the streaming integration scenario.
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
    return ManagedRuntime.make(
      Layer.mergeAll(Transfer.layer.pipe(Layer.provide(dependencies)), dependencies).pipe(
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(Settings.layerTest({ providers: { claudeAgent: { homePath: home } } })),
        Layer.provideMerge(
          Config.layerTest(repositoryRoot, { prefix: `t3-move-${environmentId}-` }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    );
  }
  const source = runtime("source", sourceRoot, sourceHome),
    destination = runtime("destination", destinationRoot, destinationHome);
  await source.runPromise(
    Effect.flatMap(Sink.EventSinkV2, (sink) => sink.write({ events: storedEvents })),
  );
  return {
    source,
    destination,
    cwd,
    sourceRoot,
    destinationRoot,
    sourceHome,
    destinationHome,
    transcript,
    setupCalls,
  };
}

type FixtureRuntime = Awaited<ReturnType<typeof fixture>>["source"];

async function uploadMove(input: {
  readonly moveId: string;
  readonly from: FixtureRuntime;
  readonly to: FixtureRuntime;
  readonly source: Transfer.ThreadMoveTransferService["Service"];
  readonly destination: Transfer.ThreadMoveTransferService["Service"];
  readonly destinationEnvironmentId: EnvironmentId;
  readonly branch: string;
}) {
  const identity = { moveId: input.moveId, threadId };
  const exported = await input.from.runPromise(
    input.source.execute({
      ...identity,
      action: "export",
      destinationEnvironmentId: input.destinationEnvironmentId,
    }),
  );
  const started = await input.to.runPromise(
    input.destination.execute({
      ...identity,
      action: "begin",
      manifest: exported.manifest!,
      projectId: ProjectId.make("move-project"),
      instanceId: providerId,
      branch: input.branch,
    }),
  );
  let offset = started.offset ?? 0;
  while (offset < exported.manifest!.parts[0]!.sizeBytes) {
    const bytes = await input.from.runPromise(
      input.source.readChunk(exported.relativeUrl!.split("/").at(-1)!, offset),
    );
    offset = await input.to.runPromise(
      input.destination.writeChunk(
        started.relativeUrl!.split("/").at(-1)!,
        offset,
        Stream.make(bytes),
      ),
    );
  }
  await input.from.runPromise(input.source.execute({ ...identity, action: "activate" }));
  return identity;
}

async function completeMove(input: Parameters<typeof uploadMove>[0]) {
  const identity = await uploadMove(input);
  const committed = await input.to.runPromise(
    input.destination.execute({ ...identity, action: "commit" }),
  );
  await input.from.runPromise(
    input.source.execute({ ...identity, action: "finalize", receipt: committed.receipt! }),
  );
}

it("updates the existing destination thread on return without replacing its prior worktree", async () => {
  const f = await fixture();
  try {
    const sourceTransfer = await f.source.runPromise(Transfer.ThreadMoveTransferService);
    const destinationTransfer = await f.destination.runPromise(Transfer.ThreadMoveTransferService);
    await completeMove({
      moveId: "round-trip-out",
      from: f.source,
      to: f.destination,
      source: sourceTransfer,
      destination: destinationTransfer,
      destinationEnvironmentId: EnvironmentId.make("destination"),
      branch: "moved/round-trip-out",
    });
    const destinationProjection = await f.destination.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (store) => store.getThreadProjection(threadId)),
    );
    const destinationCwd = destinationProjection.thread.worktreePath!;
    const destinationTranscript = NodePath.join(
      f.destinationHome,
      "projects",
      encodeClaudeProjectPath(destinationCwd),
      `${nativeId}.jsonl`,
    );
    const advancedAt = DateTime.makeUnsafe("2026-10-05T12:05:00.000Z");
    const advancedNativeRecord = `${JSON.stringify({
      type: "user",
      uuid: "33333333-3333-4333-8333-333333333333",
      parentUuid: "22222222-2222-4222-8222-222222222222",
      sessionId: nativeId,
      cwd: destinationCwd,
      timestamp: DateTime.formatIso(advancedAt),
      message: { role: "user", content: "continued on B" },
    })}\n`;
    await NodeFSP.appendFile(destinationTranscript, advancedNativeRecord);
    await NodeFSP.writeFile(NodePath.join(destinationCwd, "code.txt"), "advanced on B\n");
    await f.destination.runPromise(
      Effect.flatMap(Sink.EventSinkV2, (sink) =>
        sink.write({
          events: [
            {
              id: EventId.make("round-trip-b-message-event"),
              threadId,
              occurredAt: advancedAt,
              type: "message.updated",
              payload: {
                id: MessageId.make("round-trip-b-message"),
                threadId,
                runId: null,
                nodeId: null,
                role: "user",
                text: "continued on B",
                attachments: [],
                streaming: false,
                createdBy: "user",
                creationSource: "web",
                createdAt: advancedAt,
                updatedAt: advancedAt,
              },
            },
          ],
        }),
      ),
    );

    await completeMove({
      moveId: "round-trip-return",
      from: f.destination,
      to: f.source,
      source: destinationTransfer,
      destination: sourceTransfer,
      destinationEnvironmentId: EnvironmentId.make("source"),
      branch: "moved/round-trip-return",
    });
    const returned = await f.source.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (store) => store.getThreadProjection(threadId)),
    );
    expect(returned.thread.id).toBe(threadId);
    expect(returned.thread.archivedAt).toBeNull();
    expect(returned.thread.settledOverride).toBeNull();
    expect(returned.thread.worktreePath).not.toBe(f.cwd);
    expect(returned.messages.some((message) => message.text === "continued on B")).toBe(true);
    expect(
      await NodeFSP.readFile(NodePath.join(returned.thread.worktreePath!, "code.txt"), "utf8"),
    ).toBe("advanced on B\n");
    expect(await NodeFSP.readFile(NodePath.join(f.cwd, "code.txt"), "utf8")).toBe("unstaged\n");
    expect(
      await NodeFSP.readFile(
        NodePath.join(
          f.sourceHome,
          "projects",
          encodeClaudeProjectPath(f.cwd),
          `${nativeId}.jsonl`,
        ),
        "utf8",
      ),
    ).toBe(f.transcript);

    const returnedCwd = returned.thread.worktreePath!;
    const returnedTranscript = NodePath.join(
      f.sourceHome,
      "projects",
      encodeClaudeProjectPath(returnedCwd),
      `${nativeId}.jsonl`,
    );
    const secondAdvanceAt = DateTime.makeUnsafe("2026-10-05T12:15:00.000Z");
    await NodeFSP.appendFile(
      returnedTranscript,
      `${JSON.stringify({
        type: "user",
        uuid: "44444444-4444-4444-8444-444444444444",
        parentUuid: "33333333-3333-4333-8333-333333333333",
        sessionId: nativeId,
        cwd: returnedCwd,
        timestamp: DateTime.formatIso(secondAdvanceAt),
        message: { role: "user", content: "continued again on A" },
      })}\n`,
    );
    await NodeFSP.writeFile(NodePath.join(returnedCwd, "code.txt"), "advanced again on A\n");
    await f.source.runPromise(
      Effect.flatMap(Sink.EventSinkV2, (sink) =>
        sink.write({
          events: [
            {
              id: EventId.make("round-trip-a-message-event"),
              threadId,
              occurredAt: secondAdvanceAt,
              type: "message.updated",
              payload: {
                id: MessageId.make("round-trip-a-message"),
                threadId,
                runId: null,
                nodeId: null,
                role: "user",
                text: "continued again on A",
                attachments: [],
                streaming: false,
                createdBy: "user",
                creationSource: "web",
                createdAt: secondAdvanceAt,
                updatedAt: secondAdvanceAt,
              },
            },
          ],
        }),
      ),
    );
    await completeMove({
      moveId: "round-trip-second-return",
      from: f.source,
      to: f.destination,
      source: sourceTransfer,
      destination: destinationTransfer,
      destinationEnvironmentId: EnvironmentId.make("destination"),
      branch: "moved/round-trip-second-return",
    });
    const returnedAgain = await f.destination.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (store) => store.getThreadProjection(threadId)),
    );
    expect(returnedAgain.thread.id).toBe(threadId);
    expect(returnedAgain.thread.worktreePath).not.toBe(destinationCwd);
    expect(returnedAgain.messages.some((message) => message.text === "continued again on A")).toBe(
      true,
    );
    expect(
      await NodeFSP.readFile(NodePath.join(returnedAgain.thread.worktreePath!, "code.txt"), "utf8"),
    ).toBe("advanced again on A\n");
    expect(await NodeFSP.readFile(NodePath.join(destinationCwd, "code.txt"), "utf8")).toBe(
      "advanced on B\n",
    );
  } finally {
    await f.source.dispose();
    await f.destination.dispose();
  }
}, 30_000);

it.each([
  ["conflict", false],
  ["active or pending work", true],
] as const)(
  "rejects an existing destination with %s",
  async (expected, sourceHasTerminal) => {
    const f = await fixture({ sourceHasTerminal });
    try {
      const sourceTransfer = await f.source.runPromise(Transfer.ThreadMoveTransferService);
      const destinationTransfer = await f.destination.runPromise(
        Transfer.ThreadMoveTransferService,
      );
      await completeMove({
        moveId: `rejection-out-${sourceHasTerminal}`,
        from: f.source,
        to: f.destination,
        source: sourceTransfer,
        destination: destinationTransfer,
        destinationEnvironmentId: EnvironmentId.make("destination"),
        branch: `moved/rejection-out-${sourceHasTerminal}`,
      });
      if (!sourceHasTerminal) {
        const changedAt = DateTime.makeUnsafe("2026-10-05T12:10:00.000Z");
        await f.source.runPromise(
          Effect.flatMap(Sink.EventSinkV2, (sink) =>
            sink.write({
              events: [
                {
                  id: EventId.make("return-conflict-message-event"),
                  threadId,
                  occurredAt: changedAt,
                  type: "message.updated",
                  payload: {
                    id: MessageId.make("return-conflict-message"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: "user",
                    text: "divergent work on A",
                    attachments: [],
                    streaming: false,
                    createdBy: "user",
                    creationSource: "web",
                    createdAt: changedAt,
                    updatedAt: changedAt,
                  },
                },
              ],
            }),
          ),
        );
      }
      const previous = await f.source.runPromise(
        Effect.flatMap(Projections.ProjectionStoreV2, (store) =>
          store.getThreadProjection(threadId),
        ),
      );
      const identity = await uploadMove({
        moveId: `rejection-return-${sourceHasTerminal}`,
        from: f.destination,
        to: f.source,
        source: destinationTransfer,
        destination: sourceTransfer,
        destinationEnvironmentId: EnvironmentId.make("source"),
        branch: `moved/rejection-return-${sourceHasTerminal}`,
      });
      await expect(
        f.source.runPromise(sourceTransfer.execute({ ...identity, action: "commit" })),
      ).rejects.toThrow(expected);
      const retained = await f.source.runPromise(
        Effect.flatMap(Projections.ProjectionStoreV2, (store) =>
          store.getThreadProjection(threadId),
        ),
      );
      expect(retained.thread.worktreePath).toBe(previous.thread.worktreePath);
      expect(retained.messages.map((message) => message.id)).toEqual(
        previous.messages.map((message) => message.id),
      );
    } finally {
      await f.source.dispose();
      await f.destination.dispose();
    }
  },
  30_000,
);

it("moves full history and staged worktree with a real Claude native load, then recovers a lost commit acknowledgement", async () => {
  const f = await fixture();
  try {
    const source = await f.source.runPromise(Transfer.ThreadMoveTransferService);
    const destination = await f.destination.runPromise(Transfer.ThreadMoveTransferService);
    const identity = { moveId: "fixture-move", threadId };
    const exported = await f.source.runPromise(
      source.execute({
        ...identity,
        action: "export",
        destinationEnvironmentId: EnvironmentId.make("destination"),
      }),
    );
    const started = await f.destination.runPromise(
      destination.execute({
        ...identity,
        action: "begin",
        manifest: exported.manifest!,
        projectId: ProjectId.make("move-project"),
        instanceId: providerId,
        branch: "moved/fixture",
      }),
    );
    const downloadToken = exported.relativeUrl!.split("/").at(-1)!;
    const uploadToken = started.relativeUrl!.split("/").at(-1)!;
    await expect(
      f.source.runPromise(source.readChunk(`${downloadToken}invalid`, 0)),
    ).rejects.toThrow(/Invalid/);
    await expect(
      f.destination.runPromise(
        destination.writeChunk(uploadToken, 0, Stream.make(new Uint8Array(1024 * 1024 + 1))),
      ),
    ).rejects.toThrow(/chunk exceeds/);
    let offset = started.offset!;
    while (offset < exported.manifest!.parts[0]!.sizeBytes) {
      const bytes = await f.source.runPromise(
        source.readChunk(exported.relativeUrl!.split("/").at(-1)!, offset),
      );
      offset = await f.destination.runPromise(
        destination.writeChunk(started.relativeUrl!.split("/").at(-1)!, offset, Stream.make(bytes)),
      );
      expect(bytes.byteLength).toBeLessThanOrEqual(1024 * 1024);
      const resumedUpload = await f.destination.runPromise(
        destination.execute({
          ...identity,
          action: "begin",
          manifest: exported.manifest!,
          projectId: ProjectId.make("move-project"),
          instanceId: providerId,
          branch: "moved/fixture",
        }),
      );
      expect(resumedUpload.offset).toBe(offset);
      await expect(
        f.destination.runPromise(destination.writeChunk(uploadToken, 0, Stream.make(bytes))),
      ).rejects.toThrow(/Resume upload/);
    }
    const before = await f.source.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (p) => p.getThread(threadId)),
    );
    expect(before.archivedAt).toBeNull();
    await f.source.runPromise(source.execute({ ...identity, action: "activate" }));
    const committed = await f.destination.runPromise(
      destination.execute({ ...identity, action: "commit" }),
    );
    expect(committed.receipt?.nativeThreadId).toBe(nativeId);
    const recovered = await f.destination.runPromise(
      destination.execute({ ...identity, action: "status" }),
    );
    expect(recovered.receipt).toEqual(committed.receipt);
    const retried = await f.destination.runPromise(
      destination.execute({ ...identity, action: "commit" }),
    );
    expect(retried.receipt).toEqual(committed.receipt);
    const imported = await f.destination.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (p) => p.getThreadProjection(threadId)),
    );
    expect(imported.messages.map((message) => [message.id, message.text])).toEqual([
      ["move-original-message", "Full T3 conversation"],
    ]);
    expect(imported.thread.environmentMove).toBeNull();
    expect(imported.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId);
    expect(await git(imported.thread.worktreePath!, "show", ":code.txt")).toBe("staged");
    expect(
      await NodeFSP.readFile(NodePath.join(imported.thread.worktreePath!, "code.txt"), "utf8"),
    ).toBe("unstaged\n");
    expect(
      await NodeFSP.readFile(NodePath.join(imported.thread.worktreePath!, "untracked.txt"), "utf8"),
    ).toBe("untracked\n");
    expect(
      await f.destination.runPromise(
        Effect.flatMap(Outbox.EffectOutboxV2, (outbox) => outbox.hasUnsettledForThread(threadId)),
      ),
    ).toBe(false);
    const nativePath = NodePath.join(
      f.destinationHome,
      "projects",
      encodeClaudeProjectPath(imported.thread.worktreePath!),
      `${nativeId}.jsonl`,
    );
    expect(await NodeFSP.readFile(nativePath, "utf8")).toBe(f.transcript);
    await f.source.runPromise(
      source.execute({ ...identity, action: "finalize", receipt: recovered.receipt! }),
    );
    const finalized = await f.source.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (p) => p.getThread(threadId)),
    );
    expect(finalized.archivedAt).toBeNull();
    expect(finalized.settledOverride).toBe("settled");
    expect(finalized.environmentMove).toBeNull();
    expect(await NodeFSP.readFile(NodePath.join(f.cwd, "code.txt"), "utf8")).toBe("unstaged\n");
    await NodeFSP.writeFile(
      NodePath.join(imported.thread.worktreePath!, "code.txt"),
      "destination changes\n",
    );
    await expect(
      f.destination.runPromise(destination.execute({ ...identity, action: "undo" })),
    ).rejects.toThrow(/worktree changed/);
    const stillUsable = await f.destination.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (p) => p.getThread(threadId)),
    );
    expect(stillUsable.environmentMove).toBeNull();
    expect(stillUsable.archivedAt).toBeNull();
    await NodeFSP.writeFile(NodePath.join(imported.thread.worktreePath!, "code.txt"), "unstaged\n");
    await NodeFSP.writeFile(NodePath.join(f.cwd, "code.txt"), "source changes retained\n");
    await f.source.runPromise(source.execute({ ...identity, action: "prepareUndo" }));
    const undone = await f.destination.runPromise(
      destination.execute({ ...identity, action: "undo" }),
    );
    await f.source.runPromise(
      source.execute({ ...identity, action: "restore", cancellation: undone.cancellation! }),
    );
    const restored = await f.source.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (p) => p.getThread(threadId)),
    );
    const retired = await f.destination.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (p) => p.getThread(threadId)),
    );
    expect(restored.archivedAt).toBeNull();
    expect(restored.environmentMove).toBeNull();
    expect(retired.archivedAt).toBeNull();
    expect(retired.settledOverride).toBe("settled");
    expect(await NodeFSP.readFile(NodePath.join(f.cwd, "code.txt"), "utf8")).toBe(
      "source changes retained\n",
    );
  } finally {
    await f.source.dispose();
    await f.destination.dispose();
  }
}, 30_000);

it("a failed native resume rolls back the import and allows the source to recover", async () => {
  const f = await fixture({ failDestinationProbe: true });
  try {
    const source = await f.source.runPromise(Transfer.ThreadMoveTransferService);
    const destination = await f.destination.runPromise(Transfer.ThreadMoveTransferService);
    const identity = { moveId: "failed-probe", threadId };
    const exported = await f.source.runPromise(
      source.execute({
        ...identity,
        action: "export",
        destinationEnvironmentId: EnvironmentId.make("destination"),
      }),
    );
    const started = await f.destination.runPromise(
      destination.execute({
        ...identity,
        action: "begin",
        manifest: exported.manifest!,
        projectId: ProjectId.make("move-project"),
        instanceId: providerId,
        branch: "moved/failed-probe",
      }),
    );
    let offset = 0;
    while (offset < exported.manifest!.parts[0]!.sizeBytes) {
      const bytes = await f.source.runPromise(
        source.readChunk(exported.relativeUrl!.split("/").at(-1)!, offset),
      );
      offset = await f.destination.runPromise(
        destination.writeChunk(started.relativeUrl!.split("/").at(-1)!, offset, Stream.make(bytes)),
      );
    }
    await f.source.runPromise(source.execute({ ...identity, action: "activate" }));
    await expect(
      f.destination.runPromise(destination.execute({ ...identity, action: "commit" })),
    ).rejects.toThrow(/native resume failure/);
    const status = await f.destination.runPromise(
      destination.execute({ ...identity, action: "status" }),
    );
    expect(status.receipt).toBeUndefined();
    expect(status.cancellation).toBeDefined();
    await expect(
      f.destination.runPromise(
        Effect.flatMap(Projections.ProjectionStoreV2, (p) => p.getThread(threadId)),
      ),
    ).rejects.toThrow();
    const config = await f.destination.runPromise(Config.ServerConfig);
    await expect(
      NodeFSP.access(NodePath.join(config.worktreesDir, "moved-failed-probe")),
    ).rejects.toThrow();
    expect(
      await git(
        NodePath.join(NodePath.dirname(f.cwd), "destination"),
        "branch",
        "--list",
        "moved/failed-probe",
      ),
    ).toBe("");
    await f.source.runPromise(
      source.execute({ ...identity, action: "recover", cancellation: status.cancellation! }),
    );
    const retained = await f.source.runPromise(
      Effect.flatMap(Projections.ProjectionStoreV2, (p) => p.getThread(threadId)),
    );
    expect(retained.archivedAt).toBeNull();
    expect(retained.environmentMove).toBeNull();
    expect(await NodeFSP.readFile(NodePath.join(f.cwd, "code.txt"), "utf8")).toBe("unstaged\n");
  } finally {
    await f.source.dispose();
    await f.destination.dispose();
  }
}, 30_000);

it("keeps project deletion behind an import blocked at the native probe", async () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const f = await fixture({ probeGate: { entered, release } });
  try {
    const source = await f.source.runPromise(Transfer.ThreadMoveTransferService);
    const destination = await f.destination.runPromise(Transfer.ThreadMoveTransferService);
    const identity = { moveId: "project-delete-race", threadId };
    const exported = await f.source.runPromise(
      source.execute({
        ...identity,
        action: "export",
        destinationEnvironmentId: EnvironmentId.make("destination"),
      }),
    );
    const started = await f.destination.runPromise(
      destination.execute({
        ...identity,
        action: "begin",
        manifest: exported.manifest!,
        projectId: ProjectId.make("move-project"),
        instanceId: providerId,
        branch: "moved/project-delete-race",
      }),
    );
    let offset = 0;
    while (offset < exported.manifest!.parts[0]!.sizeBytes) {
      const bytes = await f.source.runPromise(
        source.readChunk(exported.relativeUrl!.split("/").at(-1)!, offset),
      );
      offset = await f.destination.runPromise(
        destination.writeChunk(started.relativeUrl!.split("/").at(-1)!, offset, Stream.make(bytes)),
      );
    }
    await f.source.runPromise(source.execute({ ...identity, action: "activate" }));

    await f.destination.runPromise(
      Effect.gen(function* () {
        const transfer = yield* Transfer.ThreadMoveTransferService;
        const projectService = yield* Projects.ProjectService;
        const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const projections = yield* Projections.ProjectionStoreV2;
        const commit = yield* transfer
          .execute({ ...identity, action: "commit" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const competingThreadCreate = yield* threadCommands
          .withLock(
            threadId,
            projections.getThread(threadId).pipe(
              Effect.as("exists" as const),
              Effect.catchTag("ProjectionStoreThreadNotFoundError", () =>
                Effect.succeed("missing" as const),
              ),
            ),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        const deletion = yield* projectService
          .delete({
            commandId: CommandId.make("command:project-delete-race"),
            projectId: ProjectId.make("move-project"),
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(competingThreadCreate.pollUnsafe()).toBeUndefined();
        expect(deletion.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(commit)).receipt?.threadId).toBe(threadId);
        expect(yield* Fiber.join(competingThreadCreate)).toBe("exists");
        expect((yield* Fiber.join(deletion))._tag).toBe("ProjectNotEmptyError");
      }),
    );
  } finally {
    await f.source.dispose();
    await f.destination.dispose();
  }
}, 30_000);

it("uses the durable move fence when the source journal is missing", async () => {
  const f = await fixture();
  try {
    const source = await f.source.runPromise(Transfer.ThreadMoveTransferService);
    const identity = { moveId: "missing-source-journal", threadId };
    await f.source.runPromise(
      source.execute({
        ...identity,
        action: "export",
        destinationEnvironmentId: EnvironmentId.make("destination"),
      }),
    );
    const config = await f.source.runPromise(Config.ServerConfig);
    await NodeFSP.rm(
      NodePath.join(config.stateDir, "thread-moves", `source-${identity.moveId}`, "state.json"),
    );

    expect(await f.source.runPromise(source.execute({ ...identity, action: "status" }))).toEqual({
      state: "fenced",
    });
    expect(await f.source.runPromise(source.execute({ ...identity, action: "abort" }))).toEqual({
      state: "idle",
    });
    expect(await f.source.runPromise(source.execute({ ...identity, action: "status" }))).toEqual({
      state: "idle",
    });

    const activatedIdentity = { moveId: "missing-activated-source-journal", threadId };
    await f.source.runPromise(
      source.execute({
        ...activatedIdentity,
        action: "export",
        destinationEnvironmentId: EnvironmentId.make("destination"),
      }),
    );
    await f.source.runPromise(source.execute({ ...activatedIdentity, action: "activate" }));
    await NodeFSP.rm(
      NodePath.join(
        config.stateDir,
        "thread-moves",
        `source-${activatedIdentity.moveId}`,
        "state.json",
      ),
    );
    expect(
      await f.source.runPromise(source.execute({ ...activatedIdentity, action: "status" })),
    ).toEqual({ state: "activating" });
    await expect(
      f.source.runPromise(source.execute({ ...activatedIdentity, action: "abort" })),
    ).rejects.toThrow(/journal is unavailable/);
    expect(
      await f.source.runPromise(source.execute({ ...activatedIdentity, action: "status" })),
    ).toEqual({ state: "activating" });
  } finally {
    await f.source.dispose();
    await f.destination.dispose();
  }
}, 30_000);

it("returns idle when destination status has no thread or move journal", async () => {
  const f = await fixture();
  try {
    const destination = await f.destination.runPromise(Transfer.ThreadMoveTransferService);
    await expect(
      f.destination.runPromise(
        destination.execute({
          moveId: "absent-destination-status",
          threadId: ThreadId.make("absent-destination-thread"),
          action: "status",
        }),
      ),
    ).resolves.toEqual({ state: "idle" });
  } finally {
    await f.source.dispose();
    await f.destination.dispose();
  }
}, 30_000);

it.each([false, true])(
  "runs destination setup once after import and retains the moved thread when setup fails=%s",
  async (failSetup) => {
    const f = await fixture({ failSetup });
    try {
      const source = await f.source.runPromise(Transfer.ThreadMoveTransferService);
      const destination = await f.destination.runPromise(Transfer.ThreadMoveTransferService);
      await completeMove({
        moveId: "setup-once",
        from: f.source,
        to: f.destination,
        source,
        destination,
        destinationEnvironmentId: EnvironmentId.make("destination"),
        branch: "moved/setup-once",
      });
      expect(f.setupCalls).toHaveLength(1);
      expect(f.setupCalls[0]?.environmentId).toBe("destination");
      const projection = await f.destination.runPromise(
        Effect.flatMap(Projections.ProjectionStoreV2, (store) => store.getThread(threadId)),
      );
      expect(f.setupCalls[0]?.cwd).toBe(projection.worktreePath);
      await f.destination.runPromise(
        destination.execute({ threadId, moveId: "setup-once", action: "commit" }),
      );
      expect(f.setupCalls).toHaveLength(1);
    } finally {
      await f.source.dispose();
      await f.destination.dispose();
    }
  },
);

it("advertises the destination repository HEAD for incremental exports within the project scope", async () => {
  const f = await fixture();
  try {
    await git(f.destinationRoot, "fetch", f.sourceRoot, "HEAD");
    await git(f.destinationRoot, "checkout", "-b", "shared", "FETCH_HEAD");
    const destination = await f.destination.runPromise(Transfer.ThreadMoveTransferService);
    const status = await f.destination.runPromise(
      destination.execute(
        {
          action: "status",
          moveId: "base-probe",
          threadId,
          projectId: ProjectId.make("move-project"),
        },
        ProjectId.make("move-project"),
      ),
    );
    expect(status.state).toBe("idle");
    expect(status.repositoryHeadCommit).toBe(await git(f.destinationRoot, "rev-parse", "HEAD"));
    await expect(
      f.destination.runPromise(
        destination.execute(
          {
            action: "status",
            moveId: "base-probe",
            threadId,
            projectId: ProjectId.make("another-project"),
          },
          ProjectId.make("move-project"),
        ),
      ),
    ).rejects.toThrow("outside the calling project");
  } finally {
    await f.source.dispose();
    await f.destination.dispose();
  }
});
