import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";

const PersistedServerObservabilitySettingsDocument = Schema.Struct({
  observability: Schema.Struct({
    otlpTracesUrl: Schema.String,
    otlpMetricsUrl: Schema.String,
    otlpLogsUrl: Schema.String,
  }),
});

const encodePersistedServerObservabilitySettingsDocument = Schema.encodeEffect(
  Schema.fromJsonString(PersistedServerObservabilitySettingsDocument),
);

const isDesktopBackendObservabilitySettingsReadError = Schema.is(
  DesktopBackendConfiguration.DesktopBackendObservabilitySettingsReadError,
);

const layerShellEnvironment = (prepared = true) =>
  Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
    installIntoProcess: Effect.succeed(prepared),
  });

const layerBackendConfiguration = (prepared = true) =>
  DesktopBackendConfiguration.layer.pipe(Layer.provide(layerShellEnvironment(prepared)));

const layerServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
    tailscaleServeEnabled: true,
    tailscaleServePort: 8443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

function layerEnvironment(
  baseDir: string,
  options?: {
    readonly appPath?: string;
    readonly dirname?: string;
    readonly isPackaged?: boolean;
    readonly devServerUrl?: string;
    readonly platform?: NodeJS.Platform;
    readonly resourcesPath?: string;
    readonly appVersion?: string;
    readonly processArch?: NodeJS.Architecture;
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  },
) {
  return DesktopEnvironment.layer({
    dirname: options?.dirname ?? "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: options?.platform ?? "darwin",
    processArch: options?.processArch ?? "x64",
    appVersion: options?.appVersion ?? "1.2.3",
    appPath: options?.appPath ?? "/repo",
    isPackaged: options?.isPackaged ?? true,
    resourcesPath: options?.resourcesPath ?? "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          T3CODE_PORT: "9999",
          T3CODE_MODE: "desktop",
          T3CODE_DESKTOP_LAN_HOST: "192.168.1.50",
          VITE_DEV_SERVER_URL: options?.devServerUrl,
          T3CODE_OTLP_TRACES_URL: options?.otlpTracesUrl,
          T3CODE_OTLP_METRICS_URL: options?.otlpMetricsUrl,
          T3CODE_OTLP_LOGS_URL: options?.otlpLogsUrl,
        }),
      ),
    ),
  );
}

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

const withHarness = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
  prepared = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-test-",
    });

    return yield* effect.pipe(
      Effect.provide(
        layerBackendConfiguration(prepared).pipe(
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(DesktopWslEnvironment.layerTest()),
          Layer.provideMerge(DesktopWslServerTree.layerTest()),
          Layer.provideMerge(layerEnvironment(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

interface PackagedWslHarnessContext {
  readonly baseDir: string;
  readonly archivePath: string;
  readonly hashPath: string;
  readonly archiveHash: string;
  readonly mountedAppRoot: string;
  readonly mountedEntryPath: string;
}

const withPackagedWslHarness = <A, E, R>(
  input: {
    readonly archiveHash: string;
    readonly wsl: (
      context: PackagedWslHarnessContext,
    ) => DesktopWslEnvironment.DesktopWslEnvironmentTestStub;
    readonly forbidFallback?: string;
    readonly cleanupLegacy?: Effect.Effect<void>;
    readonly forbidCleanup?: string;
  },
  effect: (
    context: PackagedWslHarnessContext,
  ) => Effect.Effect<
    A,
    E,
    R | FileSystem.FileSystem | Path.Path | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-test-",
    });
    const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
    const hashPath = `${archivePath}.sha256`;
    const mountedAppRoot = "/mnt/c/app.asar.unpacked";
    const mountedEntryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
    yield* fileSystem.makeDirectory(path.dirname(mountedEntryPath), { recursive: true });
    yield* fileSystem.writeFileString(mountedEntryPath, "");
    yield* fileSystem.writeFileString(archivePath, "archive");
    yield* fileSystem.writeFileString(hashPath, `${input.archiveHash}\n`);

    const context = {
      baseDir,
      archivePath,
      hashPath,
      archiveHash: input.archiveHash,
      mountedAppRoot,
      mountedEntryPath,
    } satisfies PackagedWslHarnessContext;
    const layerServerTree = input.forbidFallback
      ? Layer.succeed(
          DesktopWslServerTree.DesktopWslServerTree,
          DesktopWslServerTree.DesktopWslServerTree.of({
            ensure: Effect.die(input.forbidFallback),
            cleanupLegacy: input.forbidCleanup
              ? Effect.die(input.forbidCleanup)
              : (input.cleanupLegacy ?? Effect.void),
          }),
        )
      : DesktopWslServerTree.layerTest({
          result: { ok: true, root: path.join(baseDir, "app.asar.unpacked") },
          cleanupLegacy: input.cleanupLegacy ?? Effect.void,
        });

    return yield* effect(context).pipe(
      Effect.provide(
        layerBackendConfiguration().pipe(
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(layerServerTree),
          Layer.provideMerge(
            DesktopWslEnvironment.layerTest({
              isAvailable: true,
              distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              windowsToWslPath: () => Option.some(mountedAppRoot),
              getDistroIp: () => Option.some("172.27.0.99"),
              ...input.wsl(context),
            }),
          ),
          Layer.provideMerge(
            layerEnvironment(baseDir, {
              appPath: baseDir,
              platform: "win32",
              resourcesPath: baseDir,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopBackendConfiguration", () => {
  it.effect("only the local primary bootstrap claims the prepared shell environment", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const primary = yield* configuration.resolvePrimary;
        const wsl = yield* configuration.resolveWsl({ port: 5000, distro: null });

        assert.equal(primary.bootstrap.shellEnvironmentPrepared, true);
        // A WSL server runs on its own Linux user environment and must hydrate it.
        assert.isUndefined(wsl.bootstrap.shellEnvironmentPrepared);
      }),
    ),
  );

  it.effect("keeps server hydration enabled when desktop preparation failed", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const primary = yield* configuration.resolvePrimary;
        assert.equal(primary.bootstrap.shellEnvironmentPrepared, false);
      }),
      false,
    ),
  );

  it.effect("resolveWsl reuses the primary's bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const primary = yield* configuration.resolvePrimary;
        const wsl = yield* configuration.resolveWsl({ port: 5000, distro: null });

        assert.equal(wsl.bootstrap.desktopBootstrapToken, primary.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("resolveWsl falls back to the mounted runtime when archive staging fails", () => {
    const observedNodePtyRoots: string[] = [];
    return withPackagedWslHarness(
      {
        archiveHash: "b".repeat(64),
        wsl: () => ({
          prepareRuntime: () => ({ ok: false, reason: "archive is corrupt" }),
          ensureNodePty: (_distro, root) => {
            observedNodePtyRoots.push(root);
            return { ok: true, nodePath: "/usr/bin/node", resolvedPath: "/usr/bin:/bin" };
          },
        }),
      },
      ({ mountedAppRoot, mountedEntryPath }) =>
        Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });

          assert.deepEqual(observedNodePtyRoots, [mountedAppRoot]);
          assert.equal(config.entryPath, mountedEntryPath);
          assert.include(config.args, "/usr/bin/node");
          assert.include(config.args, `${mountedAppRoot}/apps/server/dist/bin.mjs`);
          assert.isUndefined(config.wslRuntimeId);
          assert.isTrue(Option.isNone(config.preflightFailure));
        }),
    );
  });

  it.effect("resolveWsl keeps the staged runtime when the mounted tree fails too", () => {
    const stagedAppRoot = "/home/test/.t3/wsl-runtime/cache";
    const invalidatedRuntimeIds: string[] = [];
    return withPackagedWslHarness(
      {
        archiveHash: "d".repeat(64),
        wsl: () => ({
          prepareRuntime: () => ({ ok: true, linuxAppRoot: stagedAppRoot }),
          invalidateRuntime: (_distro, runtimeId) =>
            Effect.sync(() => {
              invalidatedRuntimeIds.push(runtimeId);
            }),
          probeRuntime: () => ({
            ok: false,
            reason: "unsupported CPU architecture or incompatible system libraries",
          }),
          ensureNodePty: () => ({
            ok: false,
            reason: "mounted tree is broken in some other way",
            fatal: true,
          }),
        }),
      },
      () =>
        Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
          const failure = Option.getOrThrow(config.preflightFailure);

          assert.isTrue(failure.fatal);
          assert.include(failure.reason, "unsupported CPU architecture");
          assert.deepEqual(invalidatedRuntimeIds, []);
        }),
    );
  });

  it.effect("resolvePrimary surfaces persisted backend observability endpoints", () =>
    withHarness(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        yield* fileSystem.makeDirectory(environment.path.dirname(environment.serverSettingsPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          environment.serverSettingsPath,
          yield* encodePersistedServerObservabilitySettingsDocument({
            observability: {
              otlpTracesUrl: " http://127.0.0.1:4318/v1/traces ",
              otlpMetricsUrl: " http://127.0.0.1:4318/v1/metrics ",
              otlpLogsUrl: " http://127.0.0.1:4318/v1/logs ",
            },
          }),
        );

        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.otlpTracesUrl, "http://127.0.0.1:4318/v1/traces");
        assert.equal(config.bootstrap.otlpMetricsUrl, "http://127.0.0.1:4318/v1/metrics");
        assert.equal(config.bootstrap.otlpLogsUrl, "http://127.0.0.1:4318/v1/logs");
      }),
    ),
  );

  it.effect("resolvePrimary omits backend observability endpoints when settings are missing", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;

        assert.isUndefined(config.bootstrap.otlpTracesUrl);
        assert.isUndefined(config.bootstrap.otlpMetricsUrl);
        assert.isUndefined(config.bootstrap.otlpLogsUrl);
      }),
    ),
  );

  it.effect("resolveWsl carries environment-configured observability endpoints", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: null });

        // No settings.json exists here: the endpoints come from the desktop
        // environment, and the bootstrap carries them for a WSL child that
        // lacks the variables.
        assert.equal(config.bootstrap.otlpTracesUrl, "http://127.0.0.1:4318/v1/traces");
        assert.equal(config.bootstrap.otlpMetricsUrl, "http://127.0.0.1:4318/v1/metrics");
        assert.equal(config.bootstrap.otlpLogsUrl, "http://127.0.0.1:4318/v1/logs");
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                windowsToWslPath: () => Option.some("/mnt/c/repo/apps/server/src/index.ts"),
                getDistroIp: () => Option.some("172.27.0.99"),
              }),
            ),
            Layer.provideMerge(
              layerEnvironment(baseDir, {
                platform: "win32",
                otlpTracesUrl: " http://127.0.0.1:4318/v1/traces ",
                otlpMetricsUrl: " http://127.0.0.1:4318/v1/metrics ",
                otlpLogsUrl: " http://127.0.0.1:4318/v1/logs ",
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("environment observability endpoints win over the persisted settings file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        yield* fileSystem.makeDirectory(environment.path.dirname(environment.serverSettingsPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          environment.serverSettingsPath,
          yield* encodePersistedServerObservabilitySettingsDocument({
            observability: {
              otlpTracesUrl: "http://persisted:4318/v1/traces",
              otlpMetricsUrl: "http://persisted:4318/v1/metrics",
              otlpLogsUrl: "http://persisted:4318/v1/logs",
            },
          }),
        );

        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.otlpLogsUrl, "http://env:4318/v1/logs");
        // Only the logs endpoint is set in env, so the other two still come
        // from the settings file rather than being dropped together.
        assert.equal(config.bootstrap.otlpTracesUrl, "http://persisted:4318/v1/traces");
        assert.equal(config.bootstrap.otlpMetricsUrl, "http://persisted:4318/v1/metrics");
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              layerEnvironment(baseDir, { otlpLogsUrl: "http://env:4318/v1/logs" }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("logs structured context when persisted observability settings cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const settingsPath = path.join(baseDir, "userdata", "settings.json");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: settingsPath,
      });
      const messages: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      const layerFailingFileSystem = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.fail(cause),
        }),
      );

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolvePrimary;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerBackendConfiguration().pipe(
              Layer.provideMerge(layerServerExposure),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(DesktopWslEnvironment.layerTest()),
              Layer.provideMerge(layerEnvironment(baseDir)),
              Layer.provideMerge(layerFailingFileSystem),
            ),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );

      assert.isUndefined(config.bootstrap.otlpTracesUrl);
      assert.isUndefined(config.bootstrap.otlpMetricsUrl);
      assert.isUndefined(config.bootstrap.otlpLogsUrl);

      const error = messages
        .flatMap((message) => (Array.isArray(message) ? message : [message]))
        .find(isDesktopBackendObservabilitySettingsReadError);
      assert.isDefined(error);
      assert.equal(error.settingsPath, settingsPath);
      assert.equal(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to read persisted backend observability settings at ${settingsPath}.`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimary captures backend output in dev so child logs can be persisted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.captureOutput, true);
        // Dev never shares the prod compile cache.
        assert.notInclude(config.args, "--require");
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              layerEnvironment(baseDir, {
                isPackaged: false,
                devServerUrl: "http://127.0.0.1:5733",
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl carries the kill switch into the distro", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const previousWslEnv = process.env.WSLENV;
      const previousDisabled = process.env.OTEL_SDK_DISABLED;
      const previousTelemetry = process.env.T3CODE_TELEMETRY_ENABLED;
      try {
        delete process.env.WSLENV;
        process.env.OTEL_SDK_DISABLED = "true";
        process.env.T3CODE_TELEMETRY_ENABLED = "false";

        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolveWsl({ port: 5050, distro: null });

          assert.equal(config.env.OTEL_SDK_DISABLED, "true");
          assert.include((config.env.WSLENV ?? "").split(":"), "OTEL_SDK_DISABLED");
          assert.equal(config.env.T3CODE_TELEMETRY_ENABLED, "false");
          assert.include((config.env.WSLENV ?? "").split(":"), "T3CODE_TELEMETRY_ENABLED");
        }).pipe(
          Effect.provide(
            layerBackendConfiguration().pipe(
              Layer.provideMerge(layerServerExposure),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  windowsToWslPath: () => Option.some("/mnt/c/repo/apps/server/src/index.ts"),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
            ),
          ),
        );
      } finally {
        restoreEnv("WSLENV", previousWslEnv);
        restoreEnv("OTEL_SDK_DISABLED", previousDisabled);
        restoreEnv("T3CODE_TELEMETRY_ENABLED", previousTelemetry);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolveWsl carries the standard OTLP endpoint, headers, and protocol into the distro",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });

        const standard = {
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com:4318/base?api_key=secret",
          OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=Bearer%20token",
          T3CODE_OTLP_TRACES_URL: "http://t3.example.com:4318/v1/traces",
        };
        const previousWslEnv = process.env.WSLENV;
        // A developer's own OTLP variables would be forwarded too.
        const ambientOtel = Object.entries(process.env).filter(
          ([name]) => name.startsWith("OTEL_") || name.startsWith("T3CODE_OTLP_"),
        );
        try {
          for (const [name] of ambientOtel) delete process.env[name];
          delete process.env.WSLENV;
          Object.assign(process.env, standard);

          yield* Effect.gen(function* () {
            const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
            const config = yield* configuration.resolveWsl({ port: 5050, distro: null });

            assert.equal(
              config.env.OTEL_EXPORTER_OTLP_ENDPOINT,
              "https://collector.example.com:4318/base?api_key=secret",
            );
            assert.equal(
              config.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS,
              "authorization=Bearer%20token",
            );
            // Without a flag, WSL passes the values through untranslated.
            const wslEnv = (config.env.WSLENV ?? "").split(":");
            assert.include(wslEnv, "OTEL_EXPORTER_OTLP_ENDPOINT");
            assert.include(wslEnv, "OTEL_EXPORTER_OTLP_LOGS_HEADERS");
            assert.equal(config.env.T3CODE_OTLP_TRACES_URL, "http://t3.example.com:4318/v1/traces");
            assert.include(wslEnv, "T3CODE_OTLP_TRACES_URL");
          }).pipe(
            Effect.provide(
              layerBackendConfiguration().pipe(
                Layer.provideMerge(layerServerExposure),
                Layer.provideMerge(DesktopAppSettings.layerTest()),
                Layer.provideMerge(DesktopWslServerTree.layerTest()),
                Layer.provideMerge(
                  DesktopWslEnvironment.layerTest({
                    isAvailable: true,
                    windowsToWslPath: () => Option.some("/mnt/c/repo/apps/server/src/index.ts"),
                    getDistroIp: () => Option.some("172.27.0.99"),
                  }),
                ),
                Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
              ),
            ),
          );
        } finally {
          for (const name of Object.keys(standard)) delete process.env[name];
          restoreEnv("WSLENV", previousWslEnv);
          for (const [name, value] of ambientOtel) restoreEnv(name, value);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl keeps a transient distro-list failure retryable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isFalse(failure.fatal);
        assert.equal(failure.retryLimit, 12);
        assert.include(failure.reason, "timed out");
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distroListError: new DesktopWslEnvironment.DesktopWslDistroListError({
                  reason: "wsl.exe --list --verbose timed out",
                }),
              }),
            ),
            Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl surfaces sidecar extraction failures through typed preflight", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isFalse(failure.fatal);
        assert.equal(failure.retryLimit, 12);
        assert.include(failure.reason, "could not be extracted");
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslServerTree.layerTest({
                result: {
                  ok: false,
                  reason: "WSL server files could not be extracted",
                  fatal: false,
                },
              }),
            ),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              }),
            ),
            Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl marks a missing selected distro as a fatal preflight failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Removed-Distro" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isTrue(failure.fatal);
        assert.include(failure.reason, "Removed-Distro");
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              }),
            ),
            Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimaryLabel reports the WSL distro when wsl-only and WSL is available", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "WSL (Ubuntu)");
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(
              DesktopAppSettings.layerTest({
                ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                wslBackendEnabled: true,
                wslOnly: true,
                wslDistro: "Ubuntu",
              }),
            ),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
            Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the release resource monitor when both development builds exist", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const dirname = path.join(baseDir, "apps/desktop/src");
      const releaseMonitorPath = path.join(
        baseDir,
        "native/resource-monitor/target/release/t3-resource-monitor",
      );
      const debugMonitorPath = path.join(
        baseDir,
        "native/resource-monitor/target/debug/t3-resource-monitor",
      );
      yield* fileSystem.makeDirectory(path.dirname(releaseMonitorPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(debugMonitorPath), { recursive: true });
      yield* fileSystem.writeFileString(releaseMonitorPath, "release");
      yield* fileSystem.writeFileString(debugMonitorPath, "debug");

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.resourceMonitorPath, releaseMonitorPath);
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              layerEnvironment(baseDir, {
                dirname,
                devServerUrl: "http://127.0.0.1:5733",
                isPackaged: false,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimaryLabel reports the local environment on non-Windows platforms", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "Local environment");
      }),
    ),
  );

  it.effect("resolvePrimaryLabel reports Windows when wsl-only but WSL is unavailable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        // Mirrors the resolvePrimary fall-back: the label must follow the
        // backend that actually resolves, not the persisted preference, so the
        // env switcher can't show "WSL" for a Windows backend.
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "Windows");
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(
              DesktopAppSettings.layerTest({
                ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                wslBackendEnabled: true,
                wslOnly: true,
                wslDistro: "Ubuntu",
              }),
            ),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: false })),
            Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
