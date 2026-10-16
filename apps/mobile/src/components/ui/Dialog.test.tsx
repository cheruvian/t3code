import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as IosDialog from "./Dialog";
import * as AndroidDialog from "./Dialog.android";

vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  View: "View",
  Alert: { alert: vi.fn(), prompt: vi.fn() },
}));
vi.mock("./AppText", () => ({ AppText: "Text" }));
vi.mock("./ThemedSwitch", () => ({ ThemedSwitch: "Switch" }));
vi.mock("./NativeThemeHost.android", () => ({ NativeThemeHost: "Host" }));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeVariables: {
      "--color-danger-foreground": "#ff0000",
      "--color-foreground": "#ffffff",
    },
  }),
}));
vi.mock("../../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({}),
}));
vi.mock("@expo/ui/jetpack-compose", async () => {
  const { createElement } = await import("react");
  const AlertDialog = Object.assign(
    ({ children, ...props }: { children?: ReactNode }) =>
      createElement("AlertDialog", props, children),
    {
      Title: "Title",
      Text: "Body",
      DismissButton: "DismissButton",
      ConfirmButton: "ConfirmButton",
    },
  );
  return {
    AlertDialog,
    Button: "Button",
    OutlinedButton: "OutlinedButton",
    Icon: "Icon",
    FlowRow: "FlowRow",
    Column: "Column",
    Row: "Row",
    Checkbox: "Checkbox",
    OutlinedTextField: "Input",
    Text: "Text",
    useNativeState: (value: unknown) => ({ get: () => value }),
  };
});
let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it.each(["ios", "android"] as const)(
  "%s confirmation submits selected options and resets them for the next request",
  async (platform) => {
    const Dialog = platform === "ios" ? IosDialog : AndroidDialog;
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const request = {
      title: "Settle thread",
      confirmText: "Settle",
      onConfirm,
      onCancel,
      options: [
        { id: "deleteWorktree", label: "Delete worktree", defaultChecked: false },
        { id: "removeAutomations", label: "Remove bound automations", defaultChecked: true },
      ],
    };
    await act(async () => {
      renderer = create(<Dialog.Host />);
    });
    await act(async () => Dialog.confirm(request));
    const controls = () =>
      renderer!.root.findAll(
        (node) => String(node.type) === (platform === "ios" ? "Switch" : "Checkbox"),
      );
    expect(controls().map((control) => control.props.value)).toEqual([false, true]);
    await act(async () => {
      const control = controls()[0]!;
      (platform === "ios" ? control.props.onValueChange : control.props.onCheckedChange)(true);
    });
    await act(async () => {
      if (platform === "ios")
        renderer!.root.findAll((node) => String(node.type) === "Pressable")[1]!.props.onPress();
      else renderer!.root.find((node) => String(node.type) === "Button").props.onClick();
    });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
      deleteWorktree: true,
      removeAutomations: true,
    });
    expect(controls()).toHaveLength(0);
    await act(async () => Dialog.confirm(request));
    expect(controls().map((control) => control.props.value)).toEqual([false, true]);
    await act(async () => {
      if (platform === "ios")
        renderer!.root.findAll((node) => String(node.type) === "Pressable")[0]!.props.onPress();
      else renderer!.root.find((node) => String(node.type) === "OutlinedButton").props.onClick();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledOnce();
  },
);
