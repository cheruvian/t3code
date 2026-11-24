import "~/index.css";
import { AsyncResult } from "effect/reactivity";
import type { CredentialBrokerState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { CredentialBrokerCoordinator, useCredentialAccess } from "./CredentialBrokerCoordinator";

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  allowed: new Set<string>(),
  run: vi.fn(),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => (atom === "permission" ? true : mocks.results.get(String(atom))),
}));
vi.mock("../state/credentialBroker", () => ({
  credentialBroker: {
    state: ({ environmentId }: { environmentId: string }) => environmentId,
    action: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.run }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "environment", label: "Test environment" },
      { environmentId: "remote", label: "Remote environment" },
    ],
  }),
  useEnvironment: (id: string) => ({
    label: id === "remote" ? "Remote environment" : "Test environment",
  }),
}));
vi.mock("../state/session", () => ({ useEnvironmentsWithScope: () => mocks.allowed }));
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
  mocks.allowed = new Set(["environment"]);
  mocks.results = new Map([["environment", AsyncResult.success(state)]]);
  await using screen = await render(<CredentialBrokerCoordinator />);
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());
  const first = mocks.run.mock.calls[0]?.[0];
  expect(first.input).toMatchObject({ type: "presenter", visible: true });

  // The server drops presenter registration with the old subscription.
  mocks.run.mockClear();
  mocks.results.set("environment", AsyncResult.success({ ...state }));
  await screen.rerender(<CredentialBrokerCoordinator />);
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledWith(first));
});

function CredentialAccessTrigger() {
  const access = useCredentialAccess();
  return access?.available ? (
    <button onClick={access.open}>Credential access · {access.pendingCount}</button>
  ) : null;
}

it("switches environment actions, reopens after dismissal, and excludes unauthorized environments", async () => {
  const state: CredentialBrokerState = {
    status: "ready",
    mode: "test",
    accounts: ["Local account"],
    requests: [],
    notices: [],
    grants: [],
  };
  mocks.run.mockReset();
  mocks.run.mockResolvedValue({ _tag: "Success" });
  mocks.allowed = new Set(["environment", "remote"]);
  mocks.results = new Map([
    ["environment", AsyncResult.success(state)],
    ["remote", AsyncResult.success({ ...state, accounts: ["Remote account"] })],
  ]);
  const ui = () => (
    <CredentialBrokerCoordinator>
      <CredentialAccessTrigger />
    </CredentialBrokerCoordinator>
  );
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Credential access · 0" }).click();
  await page.getByRole("combobox", { name: "Credential access environment" }).click();
  await page.getByRole("option", { name: "Remote environment" }).click();
  await page.getByRole("tab", { name: "Vaults", exact: true }).click();
  await expect.element(page.getByText("Unlocked accounts: Remote account")).toBeVisible();
  await page.getByRole("button", { name: "Refresh accounts" }).click();
  expect(mocks.run).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { type: "refresh" },
  });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Credential access · 0" }).click();
  await expect.element(page.getByText("Unlocked accounts: Remote account")).toBeVisible();
  mocks.allowed = new Set(["environment"]);
  await screen.rerender(ui());
  await screen.getByRole("button", { name: "Credential access · 0" }).click();
  await page.getByRole("combobox", { name: "Credential access environment" }).click();
  await expect
    .element(page.getByRole("option", { name: "Remote environment" }))
    .not.toBeInTheDocument();
  await page.getByRole("option", { name: "Test environment" }).click();
  await page.getByRole("tab", { name: "Vaults", exact: true }).click();
  await expect.element(page.getByText("Unlocked accounts: Local account")).toBeVisible();
});

it("keeps pending requests discoverable after dismissal without reopening on an unchanged snapshot", async () => {
  const state: CredentialBrokerState = {
    status: "ready",
    mode: "test",
    accounts: ["Remote account"],
    notices: [],
    grants: [],
    requests: [
      {
        requestId: "pending-request",
        state: "pending",
        site: "example.test",
        field: "password",
        label: "Sign in",
        reason: "Test request",
        clientClaim: "test",
        ttlSeconds: 60,
        approvalDeadline: null,
        argv: ["test"],
        cwd: "/test",
        candidates: [],
      },
    ],
  };
  mocks.run.mockReset();
  mocks.run.mockResolvedValue({ _tag: "Success" });
  mocks.allowed = new Set(["environment", "remote"]);
  mocks.results = new Map([
    ["environment", AsyncResult.success({ ...state, requests: [] })],
    ["remote", AsyncResult.success(state)],
  ]);
  const ui = () => (
    <CredentialBrokerCoordinator>
      <CredentialAccessTrigger />
    </CredentialBrokerCoordinator>
  );
  await using screen = await render(ui());
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByRole("combobox")).toHaveTextContent("Remote environment");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  mocks.results.set("remote", AsyncResult.success({ ...state }));
  await screen.rerender(ui());
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Credential access · 1" }).click();
  await expect.element(page.getByRole("combobox")).toHaveTextContent("Remote environment");
  await page.getByRole("combobox").click();
  await expect
    .element(page.getByRole("option", { name: "Remote environment · 1 pending" }))
    .toBeVisible();
  await page.getByRole("option", { name: "Test environment" }).click();
  await expect
    .element(page.getByText("Your vault is ready. New requests ask for permission here."))
    .toBeVisible();
});

it("shows account filters and requires a new credential selection after they are cleared", async () => {
  const request: CredentialBrokerState["requests"][number] = {
    requestId: "filtered-request",
    state: "pending",
    site: "github.com",
    field: "login",
    label: "GitHub sign-in",
    reason: "Sign in to the requested account",
    clientClaim: "test",
    ttlSeconds: 60,
    approvalDeadline: null,
    argv: ["test"],
    cwd: "/test",
    candidates: [],
    accountFilter: "acme",
    excludedAccounts: ["excluded@example.test"],
    canSearch: true,
  };
  const state: CredentialBrokerState = {
    status: "ready",
    mode: "test",
    accounts: ["Test vault"],
    requests: [request],
    notices: [],
    grants: [],
  };
  mocks.run.mockReset();
  mocks.run.mockResolvedValue({ _tag: "Success" });
  mocks.allowed = new Set(["environment"]);
  mocks.results = new Map([["environment", AsyncResult.success(state)]]);
  await using screen = await render(<CredentialBrokerCoordinator />);
  await expect.element(page.getByText("Only account: acme")).toBeVisible();
  await expect.element(page.getByText("Excluded accounts: excluded@example.test")).toBeVisible();
  await page.getByRole("button", { name: "Clear account filters", exact: true }).click();
  expect(mocks.run).toHaveBeenCalledWith({
    environmentId: "environment",
    input: { type: "setAccountFilters", requestId: request.requestId, enabled: false },
  });
  mocks.results.set(
    "environment",
    AsyncResult.success({
      ...state,
      requests: [
        {
          ...request,
          accountFiltersCleared: true,
          candidates: [
            {
              id: "github-login",
              name: "GitHub",
              username: "team@example.test",
              hosts: ["github.com"],
            },
          ],
        },
      ],
    }),
  );
  await screen.rerender(<CredentialBrokerCoordinator />);
  await expect.element(page.getByText("Account filters cleared", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("radio")).not.toBeChecked();
  await expect
    .element(page.getByRole("button", { name: "Allow once", exact: true }))
    .toBeDisabled();
  await page.getByRole("radio").click();
  await expect.element(page.getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Restore account filters", exact: true }).click();
  expect(mocks.run).toHaveBeenCalledWith({
    environmentId: "environment",
    input: { type: "setAccountFilters", requestId: request.requestId, enabled: true },
  });
  mocks.results.set("environment", AsyncResult.success(state));
  await screen.rerender(<CredentialBrokerCoordinator />);
  await expect.element(page.getByText("Only account: acme")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Allow once", exact: true }))
    .toBeDisabled();
});

it("saved vaults ask only for a password and another vault stays usable during unlock", async () => {
  const state: CredentialBrokerState = {
    status: "locked",
    mode: "test",
    requests: [],
    notices: [],
    grants: [],
    profiles: [
      { name: "Personal", directory: "/profiles/personal", saved: true },
      { name: "Work", directory: "/profiles/work", saved: true },
    ],
  };
  let finishUnlock: (() => void) | undefined;
  const unlocking = new Promise<void>((resolve) => {
    finishUnlock = resolve;
  });
  mocks.run.mockReset();
  mocks.run.mockImplementation(async ({ input }) => {
    if (input.type === "unlock" && input.profileDirectory === "/profiles/personal") await unlocking;
    return { _tag: "Success" };
  });
  mocks.allowed = new Set(["environment"]);
  mocks.results = new Map([["environment", AsyncResult.success(state)]]);
  const ui = () => (
    <CredentialBrokerCoordinator>
      <CredentialAccessTrigger />
    </CredentialBrokerCoordinator>
  );
  await using screen = await render(ui());
  try {
    await screen.getByRole("button", { name: "Credential access · 0" }).click();
    await page.getByRole("button", { name: "Unlock vault", exact: true }).nth(0).click();
    await expect.element(page.getByRole("heading", { name: "Unlock Personal" })).toBeVisible();
    expect(document.querySelectorAll('[role="dialog"] form input').length).toBe(1);
    await page.getByLabelText("Bitwarden master password").fill("synthetic-first");
    await page.getByRole("button", { name: "Unlock vault", exact: true }).last().click();
    await expect.element(page.getByLabelText("Bitwarden master password")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
    await expect.element(page.getByRole("heading", { name: "Unlock Work" })).toBeVisible();
    await page.getByLabelText("Bitwarden master password").fill("synthetic-second");
    await page.getByRole("button", { name: "Unlock vault", exact: true }).last().click();
    expect(mocks.run).toHaveBeenCalledWith({
      environmentId: "environment",
      input: { type: "unlock", password: "synthetic-second", profileDirectory: "/profiles/work" },
    });
    await page.getByRole("button", { name: "Add vault", exact: true }).click();
    await expect.element(page.getByLabelText("Vault name")).toBeVisible();
    await expect.element(page.getByLabelText("Bitwarden master password")).toBeVisible();
  } finally {
    finishUnlock?.();
    await unlocking;
  }
});

it("a locked request can report no saved password with a human reason", async () => {
  const state: CredentialBrokerState = {
    status: "locked",
    mode: "test",
    requests: [
      {
        requestId: "denial",
        state: "awaiting_unlock",
        site: "example.test",
        field: "login",
        label: "Login",
        reason: "Sign in",
        clientClaim: "Test",
        ttlSeconds: 60,
        approvalDeadline: null,
        argv: ["/bin/true"],
        cwd: "/tmp",
        candidates: [],
      },
    ],
    notices: [],
    grants: [],
  };
  mocks.run.mockReset();
  mocks.run.mockResolvedValue({ _tag: "Success" });
  mocks.allowed = new Set(["environment"]);
  mocks.results = new Map([["environment", AsyncResult.success(state)]]);
  await using _screen = await render(
    <CredentialBrokerCoordinator>
      <CredentialAccessTrigger />
    </CredentialBrokerCoordinator>,
  );
  await page.getByRole("tab", { name: "Requests", exact: true }).click();
  await page.getByText("Add a denial reason (optional)", { exact: true }).click();
  await page.getByLabelText("Denial reason").fill("Use Google sign-in.");
  await page.getByRole("button", { name: "No password exists" }).click();
  expect(mocks.run).toHaveBeenCalledWith({
    environmentId: "environment",
    input: {
      type: "decide",
      requestId: "denial",
      decision: "deny",
      denialReason: "no_saved_password",
      denialMessage: "Use Google sign-in.",
    },
  });
});
