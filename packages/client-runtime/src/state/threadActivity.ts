import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function activityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started")) {
    return 0;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

/**
 * Canonical order shared by thread state and activity-derived client views.
 * Legacy rows without a sequence precede sequenced rows so replaying newer
 * events cannot move pre-sequence history to the end of a thread.
 */
export function compareThreadActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const leftSequence = left.sequence;
  const rightSequence = right.sequence;
  if (leftSequence === undefined) {
    if (rightSequence !== undefined) {
      return -1;
    }
  } else if (rightSequence === undefined) {
    return 1;
  } else if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleComparison = activityLifecycleRank(left.kind) - activityLifecycleRank(right.kind);
  if (lifecycleComparison !== 0) {
    return lifecycleComparison;
  }

  return left.id.localeCompare(right.id);
}

const orderedActivitiesCache = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  ReadonlyArray<OrchestrationThreadActivity>
>();

function rememberOrderedActivities<T extends ReadonlyArray<OrchestrationThreadActivity>>(
  activities: T,
): T {
  orderedActivitiesCache.set(activities, activities);
  return activities;
}

/**
 * Returns the canonical view of an activity list. Reducer-owned arrays hit the
 * identity cache; snapshot and test inputs pay one linear sortedness check per
 * array identity and are copied only when they are out of order.
 */
export function orderThreadActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const cached = orderedActivitiesCache.get(activities);
  if (cached !== undefined) {
    return cached;
  }

  for (let index = 1; index < activities.length; index += 1) {
    if (compareThreadActivities(activities[index - 1]!, activities[index]!) > 0) {
      const ordered = [...activities].sort(compareThreadActivities);
      orderedActivitiesCache.set(activities, ordered);
      return rememberOrderedActivities(ordered);
    }
  }

  return rememberOrderedActivities(activities);
}

/**
 * Immutably inserts or replaces one activity while preserving canonical order.
 * The common unique monotonic case performs one duplicate scan and one append;
 * replacements, out-of-order events, and supersession rebuild in a single pass
 * without sorting the full history.
 */
export function upsertThreadActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activity: OrchestrationThreadActivity,
  supersedes: (existing: OrchestrationThreadActivity) => boolean = () => false,
): ReadonlyArray<OrchestrationThreadActivity> {
  const orderedActivities = orderThreadActivities(activities);
  const lastActivity = orderedActivities.at(-1);
  const canAppendInOrder =
    lastActivity === undefined || compareThreadActivities(lastActivity, activity) <= 0;

  if (canAppendInOrder) {
    let needsRebuild = false;
    for (const existing of orderedActivities) {
      if (existing.id === activity.id || supersedes(existing)) {
        needsRebuild = true;
        break;
      }
    }
    if (!needsRebuild) {
      return rememberOrderedActivities([...orderedActivities, activity]);
    }
  }

  const next: OrchestrationThreadActivity[] = [];
  let inserted = false;
  for (const existing of orderedActivities) {
    if (existing.id === activity.id || supersedes(existing)) {
      continue;
    }
    if (!inserted && compareThreadActivities(activity, existing) < 0) {
      next.push(activity);
      inserted = true;
    }
    next.push(existing);
  }
  if (!inserted) {
    next.push(activity);
  }
  return rememberOrderedActivities(next);
}
