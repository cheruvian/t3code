import type { DesktopSafeShutdownRequest } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { usePrimaryEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

/** The native lifecycle stops backends only after the server has drained accepted work. */
export function DesktopSafeShutdownCoordinator() {
  const environment = usePrimaryEnvironment();
  const control = useAtomCommand(serverEnvironment.controlDrain, { reportFailure: false });
  const awaitDrain = useAtomCommand(serverEnvironment.awaitDrain, { reportFailure: false });
  const committed = useRef(new Map<string, string>());
  const bridge = window.desktopBridge;
  const handle = useEffectEvent(async (request: DesktopSafeShutdownRequest) => {
    if (!environment || environment.connection.phase !== "connected") {
      await bridge?.resolveSafeShutdown?.(request.requestId, "failed");
      return;
    }
    // Older paired servers retain their own shutdown behavior.
    if (environment.serverConfig?.environment.capabilities.serverDrain !== true) {
      await bridge?.resolveSafeShutdown?.(request.requestId, "committed");
      return;
    }
    const environmentId = environment.environmentId;
    const start = await control({
      environmentId,
      input: { operation: "begin", action: request.action },
    });
    if (start._tag !== "Success" || start.value === null) {
      await bridge?.resolveSafeShutdown?.(request.requestId, "failed");
      return;
    }
    const result = await awaitDrain({ environmentId, input: { drainId: start.value.id } });
    if (result._tag === "Success") committed.current.set(request.requestId, start.value.id);
    await bridge?.resolveSafeShutdown?.(
      request.requestId,
      result._tag === "Success" ? "committed" : "cancelled",
    );
  });
  const reset = useEffectEvent(async (requestId: string) => {
    const drainId = committed.current.get(requestId);
    committed.current.delete(requestId);
    if (environment && drainId)
      await control({
        environmentId: environment.environmentId,
        input: { operation: "resume", drainId },
      });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native quit/update lifecycle delivers requests over IPC and waits for the server drain result
  useEffect(() => {
    const unsubscribe = bridge?.onSafeShutdownRequest?.((request) => {
      void handle(request);
    });
    const unsubscribeReset = bridge?.onSafeShutdownReset?.((requestId) => {
      void reset(requestId);
    });
    return () => {
      unsubscribe?.();
      unsubscribeReset?.();
    };
  }, [bridge]);
  return null;
}
