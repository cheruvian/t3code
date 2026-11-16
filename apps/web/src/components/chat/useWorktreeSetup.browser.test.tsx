import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { useWorktreeSetup } from "./useWorktreeSetup";

vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

const freshRef = () => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
});
function Probe({ refValue: ref }: { refValue: ReturnType<typeof freshRef> }) {
  const setup = useWorktreeSetup({
    routeThreadRef: ref,
    ownerKey: "owner",
    activeThread: undefined,
    threadRef: ref,
    serverProjection: null,
    activityRun: null,
    localPreparing: false,
    sendQueuesBehindSetup: false,
    followUpSent: false,
  });
  return <output>{setup.blocksSend ? "blocked" : "ready"}</output>;
}

it("accepts freshly allocated references to the same thread without render loops", async () => {
  await using screen = await render(<Probe refValue={freshRef()} />, { router: false });
  await expect.element(screen.getByText("ready")).toBeInTheDocument();
  await screen.rerender(<Probe refValue={freshRef()} />);
  await expect.element(screen.getByText("ready")).toBeInTheDocument();
});
