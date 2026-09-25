import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { AlertTriangleIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { formatProviderDriverKindLabel } from "../../providerModels";

export function getProviderOutageBannerKey(status: ServerProvider | null): string | null {
  const advisory = status?.outageAdvisory;
  if (!advisory || advisory.severity === "none") return null;
  return [status.instanceId, advisory.severity, advisory.message ?? ""].join("\u0000");
}

export function shouldShowProviderOutageBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
): boolean {
  const bannerKey = getProviderOutageBannerKey(status);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

export const ProviderOutageBanner = memo(function ProviderOutageBanner({
  onDismiss,
  status,
}: {
  onDismiss: () => void;
  status: ServerProvider | null;
}) {
  const advisory = status?.outageAdvisory;
  if (!status || !advisory || getProviderOutageBannerKey(status) === null) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const title =
    advisory.severity === "outage"
      ? `${providerName} is experiencing an outage`
      : `${providerName} is experiencing degraded performance`;
  const message = advisory.message ?? "Check the status page for details.";

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className={cn(
          "alert-glass relative inline-flex items-center gap-3 rounded-xl border py-3 ps-3.5 pe-10 text-card-foreground text-sm",
          advisory.severity === "outage"
            ? "border-destructive/32 text-destructive-foreground [&_svg]:text-destructive"
            : "border-warning/32 [&_svg]:text-warning",
        )}
        data-variant={advisory.severity === "outage" ? "error" : "warning"}
        role="alert"
      >
        <AlertTriangleIcon className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          <div className="line-clamp-3 text-muted-foreground">{message}</div>
          {advisory.statusPageUrl ? (
            <Button
              className="self-start px-0 text-foreground"
              render={<a href={advisory.statusPageUrl} rel="noreferrer" target="_blank" />}
              size="xs"
              variant="link"
            >
              Status page ↗
            </Button>
          ) : null}
        </div>
        <Button
          aria-label={`Dismiss ${providerName} outage notice`}
          className="absolute top-2 right-2 size-6 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );
});
