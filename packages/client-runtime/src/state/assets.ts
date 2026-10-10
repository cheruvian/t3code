import {
  ASSET_URL_BATCH_MAX_SIZE,
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  type AssetImageDimensions,
  AssetResource,
  EnvironmentId,
  type ProjectCloneSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { request, getInitialServerConfig } from "../rpc/client.ts";
import type { ProjectFaviconCache, ProjectFaviconTarget } from "../projectFaviconCache.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_IDLE_TTL_MS = 60 * 60_000;

export class InvalidAssetCollectionKeyError extends Schema.TaggedError<InvalidAssetCollectionKeyError>()(
  "InvalidAssetCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid asset collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeAssetCollectionKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);

export function parseAssetCollectionKey(
  key: string,
): readonly [EnvironmentId, ReadonlyArray<AssetResource>] {
  try {
    return decodeAssetCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidAssetCollectionKeyError({ key, cause });
  }
}

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    return new URL(relativeUrl, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

export const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("asset-url:empty"),
);

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure" }
  | {
      readonly _tag: "Success";
      readonly url: string;
      /** When the signed URL stops working, in epoch milliseconds. */
      readonly expiresAt: number;
      /** The host path the server chose to serve, when it differs from what was asked for. */
      readonly sourcePath?: string;
      /** Pixel size from the image header, when the server could read one. */
      readonly imageDimensions?: AssetImageDimensions;
    };

export function assetUrlStateFromResult(
  result: AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>,
  httpBaseUrl: string | null,
): AssetUrlState {
  if (result._tag === "Failure") return { _tag: "Failure" };
  if (httpBaseUrl === null || result._tag !== "Success") return { _tag: "Loading" };
  const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  if (url === null) return { _tag: "Failure" };
  return {
    _tag: "Success",
    url,
    expiresAt: result.value.expiresAt,
    ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
    ...(result.value.imageDimensions !== undefined
      ? { imageDimensions: result.value.imageDimensions }
      : {}),
  };
}

class AssetUrlRead extends Request.Class<
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  | Effect.Error<ReturnType<typeof request<typeof WS_METHODS.assetsCreateUrl>>>
  | Effect.Error<ReturnType<typeof getInitialServerConfig>>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  localMediaEnvironment?: Atom.Atom<{
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
  } | null>,
) {
  const resolver = RequestResolver.makeGrouped<AssetUrlRead, string>({
    key: ({ request, context }) =>
      JSON.stringify([
        Context.get(context, EnvironmentSupervisor.EnvironmentSupervisor).target.environmentId,
        // Keep filesystem reads separate so a denied file cannot hide an authorized attachment.
        ["workspace-file", "media-file", "draft-workspace-file"].includes(request.resource._tag),
      ]),
    resolver: (entries) =>
      Effect.gen(function* () {
        const supportsBatch =
          entries.length > 1 &&
          (yield* getInitialServerConfig()).environment.capabilities.assetUrlBatches === true;
        if (!supportsBatch) {
          yield* Effect.forEach(
            entries,
            (entry) =>
              request(WS_METHODS.assetsCreateUrl, entry.request).pipe(
                Effect.exit,
                Effect.map((exit) => entry.completeUnsafe(exit)),
              ),
            { concurrency: 4, discard: true },
          );
          return;
        }
        const results = yield* request(WS_METHODS.assetsCreateUrls, {
          resources: entries.map(({ request }) => request.resource),
        });
        if (results.length !== entries.length)
          return yield* Effect.die(
            new Error("Asset URL batch returned an unexpected result count."),
          );
        for (const [index, entry] of entries.entries()) {
          const result = results[index]!;
          entry.completeUnsafe(
            Result.isSuccess(result) ? Exit.succeed(result.success) : Exit.fail(result.failure),
          );
        }
      }).pipe(
        Effect.provideContext(entries[0].context),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      ),
  }).pipe(RequestResolver.batchN(ASSET_URL_BATCH_MAX_SIZE));
  const read = (input: AssetCreateUrlInput) => Effect.request(new AssetUrlRead(input), resolver);
  const execute = Effect.fn("assets.createUrl")(function* (input: AssetCreateUrlInput) {
    const result = yield* read(input).pipe(Effect.result);
    if (Result.isSuccess(result)) return result.success;
    const error = result.failure;
    const resource = input.resource;
    const local = localMediaEnvironment
      ? (yield* AtomRegistry.AtomRegistry).get(localMediaEnvironment)
      : null;
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    if (
      !local ||
      local.environmentId === supervisor.target.environmentId ||
      !(
        error._tag === "AssetWorkspaceAssetNotFoundError" ||
        error._tag === "AssetWorkspaceAssetInspectionError" ||
        error._tag === "AssetWorkspaceContextNotFoundError"
      ) ||
      resource._tag !== "media-file" ||
      !(resource.path.startsWith("/") || isWindowsAbsolutePath(resource.path)) ||
      mediaMimeTypeFromExtension(resource.path.slice(resource.path.lastIndexOf("."))) === null
    )
      return yield* error;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const asset = yield* registry.run(local.environmentId, read(input));
    // Callers resolve against the thread's server, so preserve the local server's origin.
    return { ...asset, relativeUrl: new URL(asset.relativeUrl, local.httpBaseUrl).href };
  });
  const createUrl = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:assets:create-url",
    execute,
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
    refreshTrigger: ({ input }) =>
      input.resource._tag === "media-file" ? localMediaEnvironment : undefined,
  });
  const createUrlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    return Atom.make((get) =>
      resources.map((resource) =>
        get(
          createUrl({
            environmentId,
            input: { resource },
          }),
        ),
      ),
    ).pipe(
      Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS),
      Atom.withLabel(`environment-data:assets:create-urls:${key}`),
    );
  });

  return {
    createUrl,
    createUrls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
  };
}

/**
 * Keeps project icons visible while their environment reconnects. Each resource
 * owns its last resolved URL, including a confirmed missing-icon response.
 */
export function createProjectFaviconUrlAtomFamily(input: {
  readonly imageCache?: ProjectFaviconCache;
  readonly createUrl: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Atom.Atom<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>;
  readonly preparedConnection: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<{ readonly httpBaseUrl: string }>>;
  /** The environment's tracked clones, empty when it reports none. */
  readonly projectClones?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<ProjectCloneSnapshot>>;
}) {
  const decodeKey = Schema.decodeUnknownSync(
    Schema.Tuple([EnvironmentId, Schema.String, Schema.NullOr(Schema.String)]),
  );
  const projectClones = input.projectClones;
  const family = Atom.family((key: string) => {
    const [environmentId, cwd, path] = decodeKey(JSON.parse(key));
    const resource = { _tag: "project-favicon" as const, cwd, ...(path ? { path } : {}) };
    const query = input.createUrl({ environmentId, input: { resource } });
    // A cloned project exists before its files do, and the server reports its
    // icon missing until the clone lands. Ask again whenever the clone's phase
    // changes: the first list a client sees may already say done.
    const request = projectClones
      ? query.pipe(
          Atom.makeRefreshOnSignal(
            Atom.make(
              (get) =>
                get(projectClones(environmentId)).find((clone) => clone.destinationPath === cwd)
                  ?.phase ?? null,
            ),
          ),
        )
      : query;
    const resolvedUrl = Atom.make((get): string | null => {
      const result = get(request);
      const connection = get(input.preparedConnection(environmentId));
      const state = assetUrlStateFromResult(
        result,
        Option.isSome(connection) ? connection.value.httpBaseUrl : null,
      );
      return state._tag === "Success" ? state.url : Option.getOrNull(get.self<string | null>());
    }).pipe(Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS));
    const cache = input.imageCache;
    if (!cache) return resolvedUrl;

    const target = { environmentId, cwd, faviconPath: path };
    const image = Atom.make((get) => {
      get(request);
      const url = get(resolvedUrl);
      return Effect.promise((signal) => cache.resolve(target, url, signal));
    }).pipe(Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS));

    return Atom.make((get): string | null => {
      const result = get(image);
      if (isProjectFaviconFallbackUrl(get(resolvedUrl))) return null;
      return Option.getOrElse(AsyncResult.value(result), () => cache.peek(target));
    }).pipe(Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS));
  });
  return (target: ProjectFaviconTarget) =>
    family(getProjectFaviconResourceKey(target.environmentId, target.cwd, target.faviconPath));
}
