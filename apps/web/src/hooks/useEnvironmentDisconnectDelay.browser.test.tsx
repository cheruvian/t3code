import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { useEnvironmentStateHeldFor } from "./useEnvironmentDisconnectDelay";

const first = EnvironmentId.make("env-first");
const second = EnvironmentId.make("env-second");

function Probe(props: { environmentId: EnvironmentId | null }) {
  const held = useEnvironmentStateHeldFor(props.environmentId, 1_000);
  return <output>{held ? "held" : "waiting"}</output>;
}

describe("useEnvironmentStateHeldFor", () => {
  it("shows a persistent reconnect only after grace and cancels on recovery", async () => {
    await using screen = await render(<Probe environmentId={null} />, {
      // A bare hook probe; nothing here navigates.
      router: false,
    });
    using _timers = fakeTimers();
    await screen.rerender(<Probe environmentId={first} />);
    await act(() => vi.advanceTimersByTime(999));
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(1));
    await expect.element(screen.getByText("held")).toBeInTheDocument();
    await screen.rerender(<Probe environmentId={null} />);
    await screen.rerender(<Probe environmentId={first} />);
    await act(() => vi.advanceTimersByTime(500));
    await screen.rerender(<Probe environmentId={null} />);
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();
  });
  it("restarts the delay whenever the environment changes", async () => {
    await using screen = await render(<Probe environmentId={first} />, {
      // A bare hook probe; nothing here navigates.
      router: false,
    });
    using _timers = fakeTimers();
    await screen.rerender(<Probe environmentId={second} />);
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(999));
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(1));
    await expect.element(screen.getByText("held")).toBeInTheDocument();

    await screen.rerender(<Probe environmentId={null} />);
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();
    await screen.rerender(<Probe environmentId={second} />);
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByText("held")).toBeInTheDocument();
  });
});
