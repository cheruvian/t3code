import { useEffect } from "react";
import { EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useEnvironments } from "../state/environments";
import {
  offlineMessages,
  useOfflineMessages,
  drainOfflineMessages,
} from "../state/offlineMessages";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const report = (error: unknown) =>
  toastManager.add({
    type: "error",
    title: "Could not update queued messages",
    description: error instanceof Error ? error.message : String(error),
  });

export function OfflineMessageCoordinator() {
  const { environments } = useEnvironments();
  const messages = useOfflineMessages();
  useEffect(() => {
    void offlineMessages.load().catch(report);
  }, []);
  // Sending-state changes must not create a tight retry loop on a half-open socket.
  const connectedIds = environments
    .filter((x) => x.entry.enabled && x.connection.phase === "connected")
    .map((x) => x.environmentId)
    .join(",");
  useEffect(() => {
    for (const id of connectedIds.split(",").filter(Boolean))
      void drainOfflineMessages(EnvironmentId.make(id)).catch(report);
  }, [connectedIds, messages.length]);
  return null;
}

export function OfflineMessageOutbox({
  environmentId,
  threadId,
}: {
  environmentId?: EnvironmentId;
  threadId?: ThreadId;
}) {
  const messages = useOfflineMessages();
  const visible = messages.filter(
    (x) =>
      (!environmentId || x.environmentId === environmentId) &&
      (!threadId || x.ownerThreadId === threadId),
  );
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" aria-label="Messages waiting for connection">
      {visible.map((message) => {
        const id = message.input.message.messageId;
        const sending = offlineMessages.isSending(id);
        return (
          <div
            key={id}
            className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">
                {sending
                  ? "Sending queued message…"
                  : message.error
                    ? "Could not send queued message"
                    : "Queued · sends when connected"}
              </p>
              <p className="truncate text-sm">{message.input.message.text}</p>
              {message.attachments.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {message.attachments.length} attachment
                  {message.attachments.length === 1 ? "" : "s"}
                </p>
              ) : null}
              {message.error ? <p className="text-xs text-destructive">{message.error}</p> : null}
            </div>
            {!sending ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={sending}
                onClick={() =>
                  void offlineMessages
                    .retry(id)
                    .then(() => drainOfflineMessages(message.environmentId))
                    .catch(report)
                }
              >
                Retry
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              disabled={sending}
              aria-label={`Cancel queued message: ${message.input.message.text}`}
              onClick={() => void offlineMessages.remove(id).catch(report)}
            >
              Cancel
            </Button>
          </div>
        );
      })}
    </div>
  );
}
