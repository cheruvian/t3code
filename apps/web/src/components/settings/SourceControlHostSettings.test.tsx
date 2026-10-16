import { EnvironmentId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { SourceControlProviderKind } from "@t3tools/contracts";
const bitbucket = sourceControlClients.get(SourceControlProviderKind.make("bitbucket"))!;
const definition = { ...bitbucket, settings: bitbucket.settings! };
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  saved: {
    accessToken: "stored-access-marker",
    email: "account@example.test",
    apiToken: "stored-api-marker",
  },
  update: vi.fn(async () => ({ _tag: "Success" })),
  onChange: undefined as undefined | ((value: Record<string, unknown>) => void),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_id: unknown, select: (s: unknown) => unknown) =>
    select({ sourceControlHosts: { bitbucket: state.saved } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("./ProviderSettingsForm", () => ({
  ProviderSettingsForm: (props: { onChange: typeof state.onChange }) => {
    state.onChange = props.onChange;
    return null;
  },
}));
vi.mock("../ui/button", () => ({ Button: () => null }));
import { SourceControlHostSettings } from "./SourceControlHostSettings";
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it.each([
  [{ apiToken: "replacement-api" }, { apiToken: "replacement-api", accessToken: "" }],
  [
    { accessToken: "replacement-access" },
    { accessToken: "replacement-access", apiToken: "", email: "" },
  ],
  [{ email: "updated@example.test" }, { email: "updated@example.test" }],
])(
  "switches credentials through the live settings save without retaining the other method",
  async (edit, expected) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(
        <SourceControlHostSettings
          environmentId={EnvironmentId.make("env")}
          definition={definition}
          onSaved={() => {}}
        />,
      );
    });
    await act(async () => {
      state.onChange!({ ...state.saved, ...edit });
    });
    expect(state.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: { patch: { sourceControlHosts: { bitbucket: expected } } },
    });
  },
);
