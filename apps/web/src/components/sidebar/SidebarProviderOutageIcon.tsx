import { useAtomValue } from "@effect/atom-react";
import { getProviderOutageIncidents } from "@t3tools/client-runtime/provider-outage";
import { AlertTriangleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { environmentServerConfigsAtom } from "../../state/server";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function SidebarProviderOutageIcon() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const incidents = getProviderOutageIncidents(
    [...configs.values()].flatMap((config) => config.providers),
  );
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  if (!incidents.length) return null;

  return (
    <div className="relative z-10 shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={`${incidents.length} active provider service incidents`}
          render={
            <button className="flex size-7 items-center justify-center rounded-md text-warning outline-hidden hover:bg-warning/10 focus-visible:ring-2 focus-visible:ring-ring" />
          }
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={show}
        >
          <AlertTriangleIcon aria-hidden className="size-4" />
        </PopoverTrigger>
        <PopoverPopup
          initialFocus={false}
          width="md"
          padding="compact"
          align="start"
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <div className="max-h-96 overflow-y-auto text-xs">
            <div className="mb-2 font-medium">Provider service incidents</div>
            <ul className="space-y-3">
              {incidents.map((incident) => (
                <li key={incident.id} className="space-y-1">
                  <div className="text-muted-foreground">
                    {incident.providerName} ·{" "}
                    {incident.severity === "outage" ? "Outage" : "Degraded"}
                  </div>
                  <div className="font-medium">{incident.name}</div>
                  {incident.message ? (
                    <p className="whitespace-pre-wrap text-muted-foreground">{incident.message}</p>
                  ) : null}
                  {!incident.affectsProvider ? (
                    <p className="text-muted-foreground">Other upstream service</p>
                  ) : null}
                  {incident.statusPageUrl ? (
                    <a
                      className="underline underline-offset-2"
                      href={incident.statusPageUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Status page ↗
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
