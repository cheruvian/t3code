import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";

const EDITOR_DISCOVERY_TIMEOUT = Duration.seconds(5);

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  discovery.pipe(
    Effect.timeoutOption(EDITOR_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(() => [])),
  );

/**
 * Assembles the `server.getConfig` payload. Shared by the WebSocket RPC
 * handlers and the agent-facing MCP API bridge so both surfaces serve the
 * same contract.
 */
export const loadServerConfig = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const keybindings = yield* Keybindings.Keybindings;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettingsService = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
  const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;

  const keybindingsConfig = yield* keybindings.loadConfigState;
  const providers = yield* providerRegistry.getProviders;
  const settings = ServerSettings.redactServerSettingsForClient(
    yield* serverSettingsService.getSettings,
  );
  const environment = yield* serverEnvironment.getDescriptor;
  const auth = yield* serverAuth.getDescriptor();

  return {
    environment,
    auth,
    cwd: config.cwd,
    keybindingsConfigPath: config.keybindingsConfigPath,
    keybindings: keybindingsConfig.keybindings,
    issues: keybindingsConfig.issues,
    providers,
    availableEditors: yield* resolveAvailableEditorsForConfig(
      externalLauncher.resolveAvailableEditors(),
    ),
    // Same discovery-with-timeout treatment as editors: a slow probe
    // must not stall server.getConfig, so it degrades to no targets.
    remoteOpenTargets: yield* resolveAvailableEditorsForConfig(remoteOpenTargets.resolveTargets()),
    observability: {
      logsDirectoryPath: config.logsDir,
      localTracingEnabled: true,
      ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
      otlpTracesEnabled: config.otlpTracesUrl !== undefined,
      ...(config.otlpMetricsUrl !== undefined ? { otlpMetricsUrl: config.otlpMetricsUrl } : {}),
      otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
    },
    settings,
    shellResumeCompletionMarker: true,
    threadResumeCompletionMarker: true,
    assistantPreviews: true as const,
    threadSnapshotPagination: true,
  };
});
