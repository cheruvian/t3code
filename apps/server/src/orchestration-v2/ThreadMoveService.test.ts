import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadMove from "./ThreadMoveService.ts";

const threadId = ThreadId.make("thread_move_source");
const destinationEnvironmentId = EnvironmentId.make("destination");
const projection = {
  thread: {
    id: threadId,
    providerInstanceId: ProviderInstanceId.make("codex-instance"),
  },
  providerThreads: [
    {
      driver: "codex",
      nativeThreadRef: { driver: "codex", nativeId: "native-1", strength: "strong" },
    },
  ],
  subagents: [],
  contextTransfers: [],
} as unknown as OrchestrationV2ThreadProjection;

describe("ThreadMoveService", () => {
  it.effect("routes settle-ready finalize and abort through the shared command lane", () => {
    const commands: Array<unknown> = [];
    const layer = ThreadMove.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: commands.length, storedEvents: [] });
          },
          dispatchWithPrecondition: (command, precondition) =>
            precondition.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: commands.length, storedEvents: [] };
                }),
              ),
            ),
          getThreadRecords: () => Effect.succeed(projection),
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          hasOpenForThread: () => Effect.succeed(false),
        }),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* ThreadMove.ThreadMoveService;
      const fenced = yield* service.fence({
        commandId: CommandId.make("move:fence"),
        threadId,
        moveId: "move-1",
        destinationEnvironmentId,
      });
      yield* service.abort({
        commandId: CommandId.make("move:abort"),
        threadId,
        moveId: "move-1",
      });
      yield* service.prepareActivation({
        commandId: CommandId.make("move:activate"),
        threadId,
        moveId: "move-1",
      });
      yield* service.finalize({
        commandId: CommandId.make("move:finalize"),
        threadId,
        moveId: "move-1",
        receipt: {
          version: 1,
          importId: "import-1",
          moveId: "move-1",
          threadId,
          destinationEnvironmentId,
          providerDriver: ProviderDriverKind.make("codex"),
          nativeThreadId: "native-1",
          activatedAt: "2026-01-01T00:00:00.000Z",
          manifestSha256: "a".repeat(64),
        },
      });

      assert.strictEqual(fenced.providerDriver, "codex");
      assert.deepEqual(
        commands.map((command) => (command as { type: string }).type),
        ["thread.move.fence", "thread.move.abort", "thread.move.activate", "thread.move.finalize"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails closed for providers without portable native sessions", () => {
    const unsupported = {
      ...projection,
      providerThreads: [
        {
          driver: "cursor",
          nativeThreadRef: { driver: "cursor", nativeId: "native-1", strength: "strong" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ThreadMove.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: () => Effect.die("dispatch must not run"),
          dispatchWithPrecondition: () => Effect.die("dispatch must not run"),
          getThreadRecords: () => Effect.succeed(unsupported),
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          hasOpenForThread: () => Effect.succeed(false),
        }),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* ThreadMove.ThreadMoveService;
      const exit = yield* Effect.exit(
        service.fence({
          commandId: CommandId.make("move:unsupported"),
          threadId,
          moveId: "move-2",
          destinationEnvironmentId,
        }),
      );
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an active terminal before committing the move fence", () => {
    const layer = ThreadMove.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatchWithPrecondition: (_command, precondition) =>
            precondition.pipe(
              Effect.andThen(Effect.die("dispatch must not run after a failed precondition")),
            ),
          getThreadRecords: () => Effect.succeed(projection),
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          hasOpenForThread: () => Effect.succeed(true),
        }),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* ThreadMove.ThreadMoveService;
      const failure = yield* service
        .fence({
          commandId: CommandId.make("move:active-terminal"),
          threadId,
          moveId: "move-active-terminal",
          destinationEnvironmentId,
        })
        .pipe(Effect.flip);
      assert.equal(failure.reason, "active-terminal");
    }).pipe(Effect.provide(layer));
  });
});
