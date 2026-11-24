import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import type { LucideProps } from "lucide-react";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";

export function EnvironmentIcon({
  environmentId: _environmentId,
  ...props
}: LucideProps & {
  readonly environmentId: EnvironmentId | null;
  readonly kind: EnvironmentMachineKind;
}) {
  return <EnvironmentMachineIcon {...props} />;
}
