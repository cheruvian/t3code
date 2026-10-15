import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Shared by command admission and the deployment idle check. Never serializes ordinary turns. */
export class DeploymentAdmission extends Context.Service<
  DeploymentAdmission,
  {
    readonly enter: () => boolean;
    readonly leave: () => void;
    readonly freeze: (force: boolean) => boolean;
    readonly thaw: () => void;
  }
>()("t3/cloud/DeploymentAdmission") {}

export const layer = Layer.effect(
  DeploymentAdmission,
  Effect.sync(() => {
    let frozen = false;
    let active = 0;
    return DeploymentAdmission.of({
      enter: () => {
        if (frozen) return false;
        active++;
        return true;
      },
      leave: () => {
        active--;
      },
      freeze: (force) => {
        if (!force && active > 0) return false;
        frozen = true;
        return true;
      },
      thaw: () => {
        frozen = false;
      },
    });
  }),
);
