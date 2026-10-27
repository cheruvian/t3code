import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { useIncrementalTimelineEntries } from "./useIncrementalTimelineEntries";

function Probe() {
  "use no memo";
  const entries = useIncrementalTimelineEntries("env:thread", {
    visibleTurnItems: [],
    optimisticMessages: [],
    anchoredMessages: [],
    attachmentUrlById: new Map(),
  });
  return <output>{entries.length} entries</output>;
}

it("accepts equivalent fresh timeline arrays and URL maps without a render loop", async () => {
  await using screen = await render(<Probe />, { router: false });
  await expect.element(screen.getByText("0 entries")).toBeInTheDocument();
  await screen.rerender(<Probe />);
  await expect.element(screen.getByText("0 entries")).toBeInTheDocument();
});
