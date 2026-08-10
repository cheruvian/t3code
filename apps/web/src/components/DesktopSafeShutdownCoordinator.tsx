import { useEffect, useState } from "react";

import { useAtomValue } from "@effect/atom-react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerDrainAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

export function DesktopSafeShutdownCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const drain = useAtomValue(primaryServerDrainAtom);
  const controlDrain = useAtomCommand(serverEnvironment.controlDrain, { reportFailure: true });
  const [pending, setPending] = useState<{
    readonly requestId: string;
    readonly drainId: string | null;
    readonly observed: boolean;
  } | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (bridge === undefined) return;
    return bridge.onSafeShutdownRequest((request) => {
      if (environmentId === null || pending !== null) {
        void bridge.resolveSafeShutdown(request.requestId, "failed");
        return;
      }
      setPending({ requestId: request.requestId, drainId: null, observed: false });
      void controlDrain({
        environmentId,
        input: { operation: "begin", action: request.action },
      }).then((result) => {
        if (result._tag === "Failure" || result.value === null) {
          setPending(null);
          void bridge.resolveSafeShutdown(request.requestId, "failed");
          return;
        }
        setPending({ requestId: request.requestId, drainId: result.value.id, observed: false });
      });
    });
  }, [controlDrain, environmentId, pending]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (bridge === undefined || pending === null || pending.drainId === null) return;
    if (drain?.id === pending.drainId && !pending.observed) {
      setPending({ ...pending, observed: true });
      return;
    }
    if (
      drain?.id === pending.drainId &&
      drain.phase === "committing" &&
      drain.activeWorkCount === 0
    ) {
      const requestId = pending.requestId;
      setPending(null);
      void bridge.resolveSafeShutdown(requestId, "committed");
    } else if (pending.observed && drain === null) {
      const requestId = pending.requestId;
      setPending(null);
      void bridge.resolveSafeShutdown(requestId, "cancelled");
    }
  }, [drain, pending]);

  return null;
}
