import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { useServerConfigs } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { environmentSession } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";

function EnvironmentDrainBanner({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const result = useAtomValue(serverEnvironment.drain({ environmentId, input: {} }));
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const control = useAtomCommand(serverEnvironment.controlDrain);
  const [pending, setPending] = useState(false);
  const drain = AsyncResult.getOrElse(result, () => null);
  if (drain === null) return null;
  const canMaintain =
    session._tag === "Success" &&
    session.value.authenticated &&
    sessionGrantsScope(session.value, AuthEnvironmentMaintainScope);
  const act = async (operation: "cancel" | "force") => {
    setPending(true);
    await (async () => {
      await control({ environmentId, input: { operation, drainId: drain.id } });
    })().finally(() => {
      setPending(false);
    });
  };
  return (
    <section
      role="status"
      aria-label="Active agent shutdown"
      className="flex flex-wrap items-center gap-3 border-b bg-muted px-4 py-2 text-sm"
    >
      <span>
        {label}:{" "}
        {drain.activeWorkCount === 0
          ? `Ready to ${drain.action}.`
          : `Waiting for ${drain.activeWorkCount} active agent${drain.activeWorkCount === 1 ? "" : "s"} before ${drain.action}.`}
        {drain.blockedThreadIds.length > 0 ? ` ${drain.blockedThreadIds.length} need input.` : ""}
        {drain.phase === "action-required"
          ? " Continue waiting, cancel, or stop the agents to continue."
          : ""}
      </span>
      {canMaintain && drain.canCancel ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void act("cancel")}>
          Cancel {drain.action}
        </Button>
      ) : null}
      {canMaintain && drain.canForce ? (
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => void act("force")}
        >
          Stop agents and continue
        </Button>
      ) : null}
    </section>
  );
}

export function ServerDrainBanner() {
  const configs = useServerConfigs();
  return (
    <>
      {Array.from(configs, ([environmentId, config]) =>
        config.environment.capabilities.serverDrain === true ? (
          <EnvironmentDrainBanner
            key={environmentId}
            environmentId={environmentId}
            label={config.environment.label}
          />
        ) : null,
      )}
    </>
  );
}
