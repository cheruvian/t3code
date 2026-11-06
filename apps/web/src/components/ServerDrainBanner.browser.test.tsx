import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { ServerDrainBanner } from "./ServerDrainBanner";

const state = vi.hoisted(() => ({
  drainAtom: null as unknown,
  sessionAtom: null as unknown,
  control: vi.fn(),
}));
const environmentId = EnvironmentId.make("drain-test");
vi.mock("~/state/server", () => ({
  serverEnvironment: { drain: () => state.drainAtom, controlDrain: {} },
}));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      [environmentId, { environment: { label: "Test host", capabilities: { serverDrain: true } } }],
    ]),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.control }));

function setup(maintain = true) {
  state.control.mockReset().mockResolvedValue({ _tag: "Success", value: null });
  state.drainAtom = Atom.make(
    AsyncResult.success({
      id: "drain-1",
      action: "update",
      phase: "action-required",
      activeWorkCount: 2,
      blockedThreadIds: ["thread-1"],
      canCancel: true,
      canForce: true,
      requestedAt: "2026-11-05T00:00:00Z",
    }),
  );
  state.sessionAtom = Atom.make(
    AsyncResult.success({
      authenticated: true,
      scopes: maintain ? ["environment:maintain"] : [],
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "t3_session",
        serverUpdateScope: "environment:maintain",
      },
    }),
  );
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ServerDrainBanner />
    </RegistryContext.Provider>,
  );
}

describe("active-agent shutdown controls", () => {
  it("shows active and blocked agents and sends cancellation for the current drain", async () => {
    await using screen = await setup();
    expect(screen.getByRole("status").element().textContent).toContain(
      "Waiting for 2 active agents before update.",
    );
    expect(screen.getByRole("status").element().textContent).toContain("1 need input.");
    await screen.getByRole("button", { name: "Cancel update" }).click();
    expect(state.control).toHaveBeenCalledWith({
      environmentId,
      input: { operation: "cancel", drainId: "drain-1" },
    });
  });
  it("requires the explicit stop action to force the drain", async () => {
    await using screen = await setup();
    expect(state.control).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Stop agents and continue" }).click();
    expect(state.control).toHaveBeenCalledWith({
      environmentId,
      input: { operation: "force", drainId: "drain-1" },
    });
  });
  it("shows progress without controls to clients without maintenance permission", async () => {
    await using screen = await setup(false);
    await expect.element(screen.getByRole("status")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Cancel update" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Stop agents and continue" }))
      .not.toBeInTheDocument();
  });
});
