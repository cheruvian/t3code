import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";

import type { EnvironmentId } from "@t3tools/contracts";
import type { ServerDrainSnapshot } from "@t3tools/contracts";
import { serverEnvironment } from "~/state/server";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";

export function ServerDrainBanner() {
  const { environments } = useEnvironments();

  return environments.map((environment) => (
    <EnvironmentDrainBanner
      key={environment.environmentId}
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
    />
  ));
}

function EnvironmentDrainBanner({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const drain = Option.getOrNull(
    AsyncResult.value(useAtomValue(serverEnvironment.drain({ environmentId, input: {} }))),
  );
  const controlDrain = useAtomCommand(serverEnvironment.controlDrain, { reportFailure: true });

  if (drain === null) return null;

  const act = (operation: "cancel" | "force") => {
    void controlDrain({ environmentId, input: { operation, drainId: drain.id } });
  };

  return (
    <ServerDrainBannerContent
      drain={drain}
      environmentLabel={environmentLabel}
      onCancel={() => act("cancel")}
      onForce={() => act("force")}
    />
  );
}

export function ServerDrainBannerContent({
  drain,
  environmentLabel,
  onCancel,
  onForce,
}: {
  readonly drain: ServerDrainSnapshot;
  readonly environmentLabel: string;
  readonly onCancel: () => void;
  readonly onForce: () => void;
}) {
  return (
    <aside
      role="alert"
      aria-live="assertive"
      className="relative z-[1000] border-b-2 border-amber-300 bg-amber-950 px-4 py-3 text-amber-50 shadow-2xl"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold tracking-wide uppercase">
            {drain.phase === "committing" ? "Shutting down now" : "Server shutting down safely"}
            {` — ${environmentLabel}`}
          </p>
          <p className="text-xs text-amber-100">
            {drain.activeWorkCount === 0
              ? "Active work is settled. The server can restart."
              : `Waiting for ${drain.activeWorkCount} active ${drain.activeWorkCount === 1 ? "session" : "sessions"} to finish.`}
            {drain.blockedThreadIds.length > 0
              ? ` ${drain.blockedThreadIds.length} need approval or input.`
              : ""}
          </p>
        </div>
        {drain.canCancel ? (
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel shutdown
          </Button>
        ) : null}
        {drain.canForce ? (
          <Button size="sm" variant="destructive" onClick={onForce}>
            Stop now
          </Button>
        ) : null}
      </div>
    </aside>
  );
}
