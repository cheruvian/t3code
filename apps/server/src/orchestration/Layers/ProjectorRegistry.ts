/**
 * ProjectorRegistry - declarative projector definitions and their run order.
 *
 * A projector declares the event types it handles and the projectors whose rows
 * it reads while handling them. The pipeline derives dispatch and ordering from
 * those declarations instead of from the position of a `case` in a switch or of
 * a projector in an array.
 *
 * @module ProjectorRegistry
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/** One orchestration event narrowed to a single event type. */
export type OrchestrationEventOfType<Type extends OrchestrationEvent["type"]> = Extract<
  OrchestrationEvent,
  { readonly type: Type }
>;

/**
 * Filesystem work a projector defers until its database transaction commits.
 *
 * Projectors record intent here rather than touching the attachment store
 * directly, because a rolled-back transaction must not leave deleted files
 * behind.
 */
export interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

/**
 * Handlers a projector supplies, keyed by the event type each one handles.
 *
 * The key set is the projector's subscription: an event type absent here is one
 * this projector ignores. Each handler receives its event already narrowed.
 */
export type ProjectorHandlers = {
  readonly [Type in OrchestrationEvent["type"]]?: (
    event: OrchestrationEventOfType<Type>,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
};

export interface ProjectorDefinition<Name extends string = string> {
  readonly name: Name;
  /**
   * Projectors whose rows this projector reads while applying the same event.
   *
   * The pipeline runs every declared dependency first, so a projector that
   * derives state from another projection sees that projection's writes for the
   * current event. Empty for a projector that folds only the event itself.
   */
  readonly reads: ReadonlyArray<Name>;
  readonly on: ProjectorHandlers;
}

/** Raised at construction when projector declarations cannot be ordered. */
export class ProjectorDependencyError extends Error {
  readonly _tag = "ProjectorDependencyError";

  constructor(detail: string) {
    super(`Invalid projector registry: ${detail}`);
    this.name = "ProjectorDependencyError";
  }
}

export function defineProjector<Name extends string>(
  definition: ProjectorDefinition<Name>,
): ProjectorDefinition<Name> {
  return definition;
}

/**
 * Order projectors so every projector runs after the ones it reads.
 *
 * Independent projectors keep their declaration order, which keeps the run
 * order stable and reviewable. Throws rather than guessing: an unorderable
 * registry is a programming error that must fail at startup, not silently
 * project stale derived state.
 */
export function orderProjectors<Definition extends ProjectorDefinition>(
  definitions: ReadonlyArray<Definition>,
): ReadonlyArray<Definition> {
  const byName = new Map<string, Definition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new ProjectorDependencyError(`duplicate projector '${definition.name}'`);
    }
    byName.set(definition.name, definition);
  }

  for (const definition of definitions) {
    for (const dependency of definition.reads) {
      if (!byName.has(dependency)) {
        throw new ProjectorDependencyError(
          `projector '${definition.name}' reads unknown projector '${dependency}'`,
        );
      }
      if (dependency === definition.name) {
        throw new ProjectorDependencyError(`projector '${definition.name}' reads itself`);
      }
    }
  }

  const ordered: Array<Definition> = [];
  const placed = new Set<string>();
  const remaining = [...definitions];
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((definition) =>
      definition.reads.every((dependency) => placed.has(dependency)),
    );
    if (readyIndex === -1) {
      throw new ProjectorDependencyError(
        `dependency cycle among ${remaining.map((definition) => `'${definition.name}'`).join(", ")}`,
      );
    }
    const [next] = remaining.splice(readyIndex, 1);
    if (next === undefined) {
      throw new ProjectorDependencyError("failed to select a runnable projector");
    }
    ordered.push(next);
    placed.add(next.name);
  }

  return ordered;
}
