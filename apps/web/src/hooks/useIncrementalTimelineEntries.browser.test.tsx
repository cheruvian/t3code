import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { useIncrementalTimelineEntries } from "./useIncrementalTimelineEntries";

const freshInput = () => ({
  visibleTurnItems: [],
  optimisticMessages: [],
  anchoredMessages: [],
  attachmentUrlById: new Map(),
});
function Probe({ input }: { input: Parameters<typeof useIncrementalTimelineEntries>[1] }) {
  const entries = useIncrementalTimelineEntries("env:thread", input);
  return <output>{entries.length} entries</output>;
}

it("accepts equivalent fresh timeline arrays and URL maps without a render loop", async () => {
  await using screen = await render(<Probe input={freshInput()} />, { router: false });
  await expect.element(screen.getByText("0 entries")).toBeInTheDocument();
  await screen.rerender(<Probe input={freshInput()} />);
  await expect.element(screen.getByText("0 entries")).toBeInTheDocument();
});
