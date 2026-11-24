import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { EnvironmentMachineSymbol } from "./EnvironmentMachineSymbol";

export function EnvironmentIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  return (
    <EnvironmentMachineSymbol
      kind={props.kind}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
    />
  );
}
