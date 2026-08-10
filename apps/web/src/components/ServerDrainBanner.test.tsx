import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import { ServerDrainBannerContent } from "./ServerDrainBanner";

describe("ServerDrainBannerContent", () => {
  it("renders the active and blocked counts with cancel and force controls", () => {
    const html = renderToStaticMarkup(
      <ServerDrainBannerContent
        drain={{
          id: "drain-1",
          action: "restart",
          phase: "action-required",
          activeWorkCount: 2,
          blockedThreadIds: [ThreadId.make("thread-1")],
          canCancel: true,
          canForce: true,
          requestedAt: "2026-08-10T00:00:00.000Z",
        }}
        environmentLabel="Local"
        onCancel={() => undefined}
        onForce={() => undefined}
      />,
    );

    expect(html).toContain("Server shutting down safely — Local");
    expect(html).toContain("Waiting for 2 active sessions to finish.");
    expect(html).toContain("1 need approval or input.");
    expect(html).toContain("Cancel shutdown");
    expect(html).toContain("Stop now");
  });
});
