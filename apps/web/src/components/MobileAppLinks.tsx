import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { SettingsRow } from "./settings/settingsLayout";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { QRCodeSvg } from "./ui/qr-code";

const MOBILE_DOWNLOADS = [
  {
    label: "App Store",
    url: "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824",
  },
  { label: "Google Play", url: "https://play.google.com/store/apps/details?id=com.t3tools.t3code" },
  {
    label: "Android beta APK",
    url: "https://github.com/pingdotgg/t3code/releases/tag/android-beta",
  },
];

function MobileDownload({ label, url }: { label: string; url: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Popover>
      <PopoverTrigger render={<Button size="sm" variant="outline" />}>{label}</PopoverTrigger>
      <PopoverPopup align="end">
        <div className="flex flex-col items-center gap-3">
          <PopoverTitle>{label}</PopoverTitle>
          <p className="text-xs text-muted-foreground">Scan with your phone camera.</p>
          <div className="rounded-lg bg-white p-1.5">
            <QRCodeSvg
              value={url}
              size={128}
              level="M"
              marginSize={1}
              title={`${label} download link`}
            />
          </div>
          <div className="flex gap-2">
            <Button size="xs" variant="outline" onClick={() => copyToClipboard(url)}>
              {isCopied ? "Copied" : "Copy link"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              render={<a href={url} target="_blank" rel="noreferrer noopener" />}
            >
              Open link
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function MobileAppLinks() {
  return (
    <SettingsRow
      id="mobile-app"
      title="Mobile app"
      description="Connect your phone to this environment. Store apps support stable and Nightly servers; beta builds are optional. TestFlight is invite-only."
      control={
        <div className="flex flex-wrap gap-2">
          {MOBILE_DOWNLOADS.map((link) => (
            <MobileDownload key={link.label} {...link} />
          ))}
        </div>
      }
    />
  );
}
