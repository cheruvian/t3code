import {
  ASSET_URL_BATCH_MAX_SIZE,
  type AssetCreateUrlInput,
  type AssetCreateUrlsInput,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { issueAssetUrl } from "./AssetAccess.ts";

/** Resolves workspace context once per batch, without retaining it across requests. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const projectService = yield* ProjectService.ProjectService;
  const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const assetContext = yield* Effect.context<Effect.Services<ReturnType<typeof issueAssetUrl>>>();
  const issue = (
    input: AssetCreateUrlInput,
    lookup: {
      projectByCwd: typeof projectStore.findActiveByWorkspaceRoot;
      thread: (
        id: Parameters<typeof threadManagement.getThreadRecords>[0],
      ) => ReturnType<typeof threadManagement.getThreadRecords<never>>;
      project: typeof projectService.getById;
    },
  ) =>
    Effect.gen(function* () {
      // An absolute media path can be linked from a thread on another environment.
      if (
        input.resource._tag === "attachment" ||
        input.resource._tag === "native-app-icon" ||
        input.resource._tag === "tool-output-image" ||
        input.resource._tag === "host-file-download" ||
        // GitHub media names the repository it authenticates through itself.
        input.resource._tag === "github-media" ||
        (input.resource._tag === "media-file" && path.isAbsolute(input.resource.path))
      ) {
        return yield* issueAssetUrl({ resource: input.resource });
      }
      if (input.resource._tag === "draft-workspace-file") {
        // A project draft names its workspace directly; there is no
        // thread to resolve one from.
        return yield* issueAssetUrl({
          resource: input.resource,
          workspaceRoot: input.resource.cwd,
        });
      }
      if (input.resource._tag === "project-favicon") {
        const project = yield* lookup.projectByCwd(input.resource.cwd).pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceContextResolutionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        if (Option.isNone(project)) {
          return yield* new AssetWorkspaceContextNotFoundError({
            resource: input.resource,
          });
        }
        // A cloned project exists before its files do. Clients ask again
        // when the clone lands (see createProjectFaviconUrlAtomFamily).
        const clone = yield* projectCloneTracker.get(project.value.projectId);
        return yield* issueAssetUrl({
          resource: input.resource,
          ...(project.value.faviconPath ? { projectFaviconPath: project.value.faviconPath } : {}),
          projectCheckoutPending:
            clone !== null &&
            clone.phase !== "done" &&
            clone.destinationPath === project.value.workspaceRoot,
        });
      }
      const thread = yield* lookup.thread(input.resource.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceContextResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const project = yield* lookup.project(thread.thread.projectId).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceContextResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      if (Option.isNone(project)) {
        return yield* new AssetWorkspaceContextNotFoundError({
          resource: input.resource,
        });
      }
      return yield* issueAssetUrl({
        resource: input.resource,
        workspaceRoot: thread.thread.worktreePath ?? project.value.workspaceRoot,
      });
    }).pipe(Effect.provideContext(assetContext));
  const createUrl = (input: AssetCreateUrlInput) =>
    issue(input, {
      projectByCwd: projectStore.findActiveByWorkspaceRoot,
      thread: (id) => threadManagement.getThreadRecords(id, []),
      project: projectService.getById,
    });
  const createUrls = Effect.fn("AssetUrlService.createUrls")(function* (
    input: AssetCreateUrlsInput,
  ) {
    const options = { capacity: ASSET_URL_BATCH_MAX_SIZE };
    const projectsByCwd = yield* Cache.make({
      ...options,
      lookup: projectStore.findActiveByWorkspaceRoot,
    });
    const threads = yield* Cache.make({
      ...options,
      lookup: (id: Parameters<typeof threadManagement.getThreadRecords>[0]) =>
        threadManagement.getThreadRecords(id, []),
    });
    const projects = yield* Cache.make({ ...options, lookup: projectService.getById });
    return yield* Effect.forEach(
      input.resources,
      (resource) =>
        issue(
          { resource },
          {
            projectByCwd: (cwd) => Cache.get(projectsByCwd, cwd),
            thread: (id) => Cache.get(threads, id),
            project: (id) => Cache.get(projects, id),
          },
        ).pipe(Effect.result),
      { concurrency: 4 },
    );
  });
  return { createUrl, createUrls };
});
