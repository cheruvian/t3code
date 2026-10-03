import { ResourceActionLog, type ProjectResourceLock, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeLog = Schema.decodeUnknownOption(ResourceActionLog);

export function resourceActionLogs(
  activities: readonly { readonly type: string; readonly resourceActionLog?: unknown }[],
) {
  const logs = new Map<string, ResourceActionLog>();
  for (const activity of activities) {
    if (activity.type !== "command_execution") continue;
    const decoded = decodeLog(activity.resourceActionLog);
    if (Option.isSome(decoded)) {
      const log = decoded.value;
      if (!logs.has(log.operationId) || log.status !== "running") logs.set(log.operationId, log);
    }
  }
  return [...logs.values()].reverse();
}

export function threadResourceColor(
  locks: readonly ProjectResourceLock[] | undefined,
  threadId: ThreadId,
) {
  return locks?.find((lock) => lock.threadId === threadId)?.script.resource?.color;
}

export function formatResourceActionLog(log: ResourceActionLog) {
  return [
    `${log.resourceName} · ${log.action} · ${log.status}`,
    log.command ? `$ ${log.command}` : "No shell script configured.",
    log.stdout,
    log.stderr ? `stderr:\n${log.stderr}` : "",
    log.truncated ? "[Output truncated — showing the latest output]" : "",
    log.error ?? "",
    log.status === "running" ? "Output updates while the action runs." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
