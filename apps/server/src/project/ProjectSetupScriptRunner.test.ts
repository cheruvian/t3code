import { T3ProjectFileLoader } from "./T3ProjectFileLoader.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import {
  type Project,
  type ProjectScript,
  ProjectId,
  type T3ProjectFileScript,
  type TerminalEvent,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "./ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);

const makeProject = (
  scripts: Project["scripts"],
  disabledInheritedScriptIds: readonly string[] = [],
): Project => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  disabledInheritedScriptIds,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (project: Project) =>
  Layer.succeed(ProjectService.ProjectService, {
    resourceRequest: () => Effect.die("unused"),
    resourceComplete: () => Effect.die("unused"),
    create: () => Effect.die("unused"),
    bootstrap: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    withActiveProject: () => Effect.die("unused"),
    snapshot: Effect.die("unused"),
    getShell: () => Effect.die("unused"),
    listShells: () => Effect.die("unused"),
    getById: (id) => Effect.succeed(id === project.id ? Option.some(project) : Option.none()),
    getByWorkspaceRoot: (root) =>
      Effect.succeed(root === project.workspaceRoot ? Option.some(project) : Option.none()),
  });

type TerminalOverrides = Pick<TerminalManager.TerminalManager["Service"], "open" | "write"> &
  Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe" | "closeIdle">>;

const makeTerminalManagerLayer = (overrides: TerminalOverrides) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    hasOpenForThread: () => Effect.succeed(false),
    observeStream: () => Effect.die(new Error("unused")),
    attachStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    closeIdle: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
    ...overrides,
  });

const testLayer = (
  project: Project,
  terminal: TerminalOverrides,
  settings:
    | ReturnType<typeof ServerSettings.layerTest>
    | readonly ProjectScript[] = ServerSettings.layerTest(),
  fileScripts: readonly T3ProjectFileScript[] = [],
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.succeed(T3ProjectFileLoader, {
        load: () => Effect.succeed(Option.some({ scripts: [...fileScripts] })),
      }),
    ),
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(terminal)),
    Layer.provide(
      Array.isArray(settings)
        ? ServerSettings.layerTest({ globalScripts: settings })
        : (settings as ReturnType<typeof ServerSettings.layerTest>),
    ),
  );

describe("ProjectSetupScriptRunner", () => {
  it.effect("runs the inherited machine setup action in the checkout's worktree", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-default-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result).toMatchObject({ status: "started", scriptId: "default-setup" });
      expect(open).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          COLORTERM: "",
        },
      });
      expect(write).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        data: "npm install\r",
      });
    }).pipe(
      Effect.provide(
        testLayer(
          makeProject([]),
          { open, write },
          ServerSettings.layerTest({
            defaultProjectScripts: [
              {
                id: "default-setup",
                name: "Setup",
                command: "npm install",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ],
          }),
        ),
      ),
    );
  });

  it.effect("returns no-script when no setup script exists", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect(
    "opens the deterministic setup terminal with worktree env and writes the command",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
        });

        expect(result).toEqual({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "bun install",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          async: true,
        });
        expect(open).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          env: {
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            COLORTERM: "",
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          },
        });
        expect(write).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: "bun install\r",
        });
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    },
  );

  it.effect("runs an inherited global setup action", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-global-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-global-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() => Effect.void);
    const globalScripts = [
      {
        id: "global-setup",
        name: "Global setup",
        command: "pnpm install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
    ];
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result.status).toBe("started");
      expect(write).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-global-setup",
        data: "pnpm install\r",
      });
    }).pipe(Effect.provide(testLayer(makeProject([]), { open, write }, globalScripts)));
  });

  it.effect("runs a t3.json setup action and lets a project action override it", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-project-setup",
        cwd: "/repo/project",
        worktreePath: "/repo/project",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-project-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() => Effect.void);
    const fileScripts = [
      {
        name: "Setup",
        command: "file setup",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
    ];
    const project = makeProject([
      {
        id: "project-setup",
        name: "Setup",
        command: "project setup",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/project",
      });
      expect(write).toHaveBeenCalledWith(expect.objectContaining({ data: "project setup\r" }));
    }).pipe(Effect.provide(testLayer(project, { open, write }, [], fileScripts)));
  });

  it.effect.each([false, true])(
    "does not run a disabled t3.json setup action with supplied project %s",
    (supplied) => {
      const open = vi.fn(() => Effect.die("unexpected open"));
      const write = vi.fn(() => Effect.die("unexpected write"));
      const fileScripts = [{ name: "Setup", command: "file setup", runOnWorktreeCreate: true }];
      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          ...(supplied ? { project: makeProject([], ["file:setup"]) } : {}),
          worktreePath: "/repo/worktrees/a",
        });
        expect(result).toEqual({ status: "no-script" });
      }).pipe(
        Effect.provide(
          testLayer(makeProject([], ["file:setup"]), { open, write }, [], fileScripts),
        ),
      );
    },
  );

  it.effect("prefers a project setup action over a global one", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-project-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-project-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() => Effect.void);
    const project = makeProject([
      {
        id: "project-setup",
        name: "Setup",
        command: "project",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    const globals = [
      {
        id: "global-setup",
        name: "Global",
        command: "global",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
    ];
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(write).toHaveBeenCalledWith(expect.objectContaining({ data: "project\r" }));
    }).pipe(Effect.provide(testLayer(project, { open, write }, globals)));
  });

  it.effect("does not run a disabled global setup action", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const globals = [
      {
        id: "global-setup",
        name: "Global",
        command: "global",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
    ];
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result).toEqual({ status: "no-script" });
    }).pipe(Effect.provide(testLayer(makeProject([], ["global-setup"]), { open, write }, globals)));
  });

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open: () => Effect.fail(terminalError),
          write: () => Effect.die("unexpected write"),
        }),
      ),
    );
  });
  it.effect(
    "wraps the command with a completion sentinel and resolves the exit code from terminal output",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const writes: string[] = [];
      const write = vi.fn((input: { data: string }) =>
        Effect.sync(() => void writes.push(input.data)),
      );
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
        listener = next;
        return Effect.succeed(() => {
          listener = null;
        });
      });
      const closeIdle = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);
      const emit = (data: string) =>
        Effect.suspend(() =>
          listener
            ? listener({ threadId: "thread-1", terminalId: "setup-setup", type: "output", data })
            : Effect.void,
        );

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const seen: string[] = [];
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {
            onOutputLine: (line) => Effect.sync(() => void seen.push(line)),
          },
        });
        expect(result.status).toBe("started");
        if (result.status !== "started") return;
        expect(result.completion).toBeDefined();

        // The subscription is attached before the command is written.
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(writes).toHaveLength(1);
        // The block closes on its own line so a trailing comment in the
        // command cannot swallow the sentinel, and the sentinel carries a
        // per-run token so script output cannot spoof it.
        const written = writes[0] ?? "";
        const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
        expect(sentinel).toBeDefined();
        expect(written).toBe(`( bun install\r); printf '\\n${sentinel}%s\\n' "$?"\r`);

        // Output arrives in chunks; partial lines are buffered until a newline,
        // control sequences are stripped, and the echoed wrapper is hidden.
        yield* emit(`( bun install\r\n> ); printf '\\n${sentinel}%s\\n' "$?"\r\n`);
        yield* emit("\u001b[32mResolving");
        yield* emit(" deps\u001b[0m\r\n");
        // Progress redraws separated by bare carriage returns are their own lines.
        yield* emit("Progress: 1/3\rProgress: 2/3\rProgress: 3/3\r\nDone in 2s\r\n");
        // A spoofed sentinel from the script itself must not settle completion.
        yield* emit("__T3_SETUP_DONE__:0\r\n");
        yield* emit(`__T3_SETUP_DONE___${"0".repeat(32)}:0\r\n`);
        yield* emit(`${sentinel}3\r\n$ `);

        const completion = yield* result.completion!;
        expect(completion.exitCode).toBe(3);
        expect(seen).toEqual([
          "Resolving deps",
          "Progress: 1/3",
          "Progress: 2/3",
          "Progress: 3/3",
          "Done in 2s",
          "__T3_SETUP_DONE__:0",
          `__T3_SETUP_DONE___${"0".repeat(32)}:0`,
        ]);
        // The subscription is torn down once the sentinel arrives.
        expect(listener).toBeNull();
        // A failed run keeps its shell open for a look.
        expect(closeIdle).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(testLayer(project, { open, write, subscribe, closeIdle })),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/zsh" }),
      );
    },
  );

  it.effect("closes the idle setup shell after a clean exit", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    let written = "";
    const write = vi.fn((input: { data: string }) =>
      Effect.sync(() => void (written = input.data)),
    );
    let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
    const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
      listener = next;
      return Effect.succeed(() => {
        listener = null;
      });
    });
    const closeIdle = vi.fn(() => Effect.void);
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        observeCompletion: {},
      });
      if (result.status !== "started" || !result.completion) {
        return yield* Effect.die("expected an observed setup run");
      }
      const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
      yield* listener!({
        threadId: "thread-1",
        terminalId: "setup-setup",
        type: "output",
        data: `${sentinel}0\r\n$ `,
      });

      expect((yield* result.completion).exitCode).toBe(0);
      expect(closeIdle).toHaveBeenCalledWith({ threadId: "thread-1", terminalId: "setup-setup" });
    }).pipe(
      Effect.provide(testLayer(project, { open, write, subscribe, closeIdle })),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/zsh" }),
    );
  });

  it.effect("unsubscribes from terminal output when the command cannot be written", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() =>
      Effect.fail(
        new TerminalManager.TerminalCwdStatError({ cwd: "/repo/worktrees/a", cause: {} }),
      ),
    );
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => Effect.succeed(unsubscribe));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {},
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer(project, { open, write, subscribe })));
  });

  it.effect.each([
    {
      shell: "/usr/bin/fish",
      expected:
        /^begin\rbun install\rend; printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' \$status\r$/,
    },
    {
      shell: "/bin/bash",
      expected: /^\( bun install\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
    },
  ])("wraps the command for the $shell syntax", ({ shell, expected }) => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const writes: string[] = [];
    const write = vi.fn((input: { data: string }) =>
      Effect.sync(() => void writes.push(input.data)),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        observeCompletion: {},
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(expected);
    }).pipe(
      Effect.provide(testLayer(project, { open, write })),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { SHELL: shell }),
    );
  });

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open: () => Effect.fail(terminalError),
          write: () => Effect.die("unexpected write"),
        }),
      ),
    );
  });
});

it.effect("resolves setup scripts through the standalone project service", () => {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Shell",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => Effect.void,
  );
  const closeIdle = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0]) => Effect.void,
  );
  const listeners: Array<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]> =
    [];
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.push(listener);
      return () => undefined;
    });
  const projectId = ProjectId.make("project:setup-runner-v2");
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "vp install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
    ],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ open, write, subscribe, closeIdle }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
        Layer.mock(T3ProjectFileLoader)({ load: () => Effect.succeed(Option.none()) }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
    });
    assert.deepEqual(result, {
      status: "started",
      async: true,
      scriptId: "setup",
      scriptName: "Setup",
      scriptCommand: "vp install",
      terminalId: "setup-setup",
      cwd: "/repo-worktree",
    });
    assert.equal(open.mock.calls[0]?.[0].cwd, "/repo-worktree");
    assert.deepEqual(open.mock.calls[0]?.[0].env, {
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo-worktree",
      COLORTERM: "",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    });
    assert.equal(write.mock.calls[0]?.[0].data, "vp install\r");
    const lines: string[] = [];
    const observed = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {
        onOutputLine: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      },
    });
    assert.equal(observed.status, "started");
    const listener = listeners[0]!;
    yield* listener({
      type: "output",
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "Downloading 10%\rDownloading 20%\r\nDone\n",
    });
    assert.deepEqual(lines, ["Downloading 10%", "Downloading 20%", "Done"]);
    yield* listener({ type: "closed", threadId: "thread-1", terminalId: "setup-setup" });

    const settle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
    });
    const settleTerminalId = settle.status === "started" ? settle.terminalId : "";
    assert.match(settleTerminalId, /^settle-clean-/);
    assert.equal(write.mock.calls.at(-1)?.[0].data, "cargo clean\r");

    // A clean run closes its shell once the prompt is back, not at the
    // sentinel, so the prompt redraw is not taken for new activity.
    const observedSettle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
      observeCompletion: {},
    });
    const observedTerminalId = observedSettle.status === "started" ? observedSettle.terminalId : "";
    // Each settle gets its own shell, so a busy one is never typed into.
    assert.notEqual(observedTerminalId, settleTerminalId);
    const token = /__T3_SETUP_DONE___(\w+):/.exec(write.mock.calls.at(-1)?.[0].data ?? "")?.[1];
    const settleListener = listeners.at(-1)!;
    const completion = yield* Effect.forkChild(
      observedSettle.status === "started" && observedSettle.completion
        ? observedSettle.completion
        : Effect.die("no completion"),
    );
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: `\r\n__T3_SETUP_DONE___${token}:0\r\n`,
    });
    yield* Effect.yieldNow;
    assert.equal(closeIdle.mock.calls.length, 0);
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: "$ ",
    });
    assert.deepEqual((yield* Fiber.join(completion)).exitCode, 0);
    assert.deepEqual(closeIdle.mock.calls[0]?.[0], {
      threadId: "thread-1",
      terminalId: observedTerminalId,
    });
  }).pipe(Effect.provide(layer));
});
