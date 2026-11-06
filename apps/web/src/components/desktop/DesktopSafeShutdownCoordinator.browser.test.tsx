import type { DesktopSafeShutdownRequest } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../../test/render";
import { DesktopSafeShutdownCoordinator } from "./DesktopSafeShutdownCoordinator";

const state = vi.hoisted(() => ({
  supported: true,
  control: vi.fn(),
  awaitDrain: vi.fn(),
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({
    environmentId: "local",
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { serverDrain: state.supported } } },
  }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { controlDrain: "control", awaitDrain: "await" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "control" ? state.control : state.awaitDrain),
}));
function setup() {
  state.supported = true;
  state.control.mockReset().mockResolvedValue({ _tag: "Success", value: { id: "drain" } });
  let finish!: (result: { _tag: "Success" | "Failure" }) => void;
  state.awaitDrain.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let request!: (request: DesktopSafeShutdownRequest) => void;
  let reset!: (id: string) => void;
  const bridge = {
    onSafeShutdownRequest: (callback: typeof request) => {
      request = callback;
      return vi.fn();
    },
    onSafeShutdownReset: (callback: typeof reset) => {
      reset = callback;
      return vi.fn();
    },
    resolveSafeShutdown: vi.fn().mockResolvedValue(undefined),
  };
  return {
    bridge,
    request: () => request({ requestId: "native", action: "update" }),
    reset: () => reset("native"),
    finish: (result: "Success" | "Failure") => finish({ _tag: result }),
  };
}
it.each(["Success", "Failure"] as const)(
  "native update waits for drain %s before resolving",
  async (result) => {
    const h = setup();
    using _bridge = stubGlobal("desktopBridge", h.bridge);
    await using _screen = await render(<DesktopSafeShutdownCoordinator />);
    await act(() => h.request());
    expect(state.control).toHaveBeenCalledWith({
      environmentId: "local",
      input: { operation: "begin", action: "update" },
    });
    expect(state.awaitDrain).toHaveBeenCalledWith({
      environmentId: "local",
      input: { drainId: "drain" },
    });
    expect(h.bridge.resolveSafeShutdown).not.toHaveBeenCalled();
    await act(() => h.finish(result));
    await vi.waitFor(() =>
      expect(h.bridge.resolveSafeShutdown).toHaveBeenCalledWith(
        "native",
        result === "Success" ? "committed" : "cancelled",
      ),
    );
    await act(() => h.reset());
    if (result === "Success")
      expect(state.control).toHaveBeenLastCalledWith({
        environmentId: "local",
        input: { operation: "resume", drainId: "drain" },
      });
    else expect(state.control).toHaveBeenCalledTimes(1);
  },
);
it("retains native shutdown compatibility for an older server", async () => {
  const h = setup();
  state.supported = false;
  using _bridge = stubGlobal("desktopBridge", h.bridge);
  await using _screen = await render(<DesktopSafeShutdownCoordinator />);
  await act(() => h.request());
  expect(h.bridge.resolveSafeShutdown).toHaveBeenCalledWith("native", "committed");
  expect(state.control).not.toHaveBeenCalled();
});
