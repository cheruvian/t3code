import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS, useThreadJumpHintsVisible } from "./Sidebar.logic";

function Probe({ show }: { show: boolean }) {
  return <output>{useThreadJumpHintsVisible(show) ? "visible" : "hidden"}</output>;
}

it("reveals hints only after the modifier stays held", async () => {
  await using screen = await render(<Probe show={false} />, {
    // The probe drives a hook without navigation.
    router: false,
  });
  using _timers = fakeTimers();
  await screen.rerender(<Probe show />);
  await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1));
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(1));
  await expect.element(screen.getByText("visible")).toBeInTheDocument();
  await screen.rerender(<Probe show={false} />);
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();
});

it("cancels an early release and gives a new hold its full delay", async () => {
  await using screen = await render(<Probe show={false} />, {
    // The probe drives a hook without navigation.
    router: false,
  });
  using _timers = fakeTimers();
  await screen.rerender(<Probe show />);
  await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
  await screen.rerender(<Probe show={false} />);
  await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();
  await screen.rerender(<Probe show />);
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
  await expect.element(screen.getByText("visible")).toBeInTheDocument();
});
