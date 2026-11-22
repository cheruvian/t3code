import { AsyncResult } from "effect/reactivity";
import type { CredentialBrokerState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { CredentialBrokerCoordinator } from "./CredentialBrokerCoordinator";

const mocks = vi.hoisted(() => ({
  result: undefined as unknown,
  run: vi.fn(),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => (atom === "permission" ? true : mocks.result),
}));
vi.mock("../state/credentialBroker", () => ({
  credentialBroker: { state: () => null, action: { permissionAtom: () => "permission" } },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.run }));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => ["environment"],
  useEnvironment: () => ({ label: "Test environment" }),
}));
vi.mock("../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../state/entities", () => ({ useProject: () => undefined }));
vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: () => null }));

it("restores the visible approval presenter after a subscription reconnect with unchanged vault status", async () => {
  const state: CredentialBrokerState = {
    status: "ready",
    mode: "test",
    requests: [],
    notices: [],
    grants: [],
  };
  mocks.run.mockReset();
  mocks.run.mockResolvedValue({ _tag: "Success" });
  mocks.result = AsyncResult.success(state);
  await using screen = await render(<CredentialBrokerCoordinator />);
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());
  const first = mocks.run.mock.calls[0]?.[0];
  expect(first.input).toMatchObject({ type: "presenter", visible: true });

  // The server drops presenter registration with the old subscription.
  mocks.run.mockClear();
  mocks.result = AsyncResult.success({ ...state });
  await screen.rerender(<CredentialBrokerCoordinator />);
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledWith(first));
});
