import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, View } from "react-native";

import { cn } from "../../lib/cn";
import { AppText } from "./AppText";
import { ThemedSwitch } from "./ThemedSwitch";
import type { ConfirmDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest } from "./Dialog.types";

type DialogRequest = { readonly request: ConfirmDialogRequest };

let presentRequest: ((request: DialogRequest) => void) | null = null;

/** Presents a confirmation with independently selectable options. */
export function showOptionsDialog(request: ConfirmDialogRequest): void {
  presentRequest?.({ request });
}

export function OptionsDialogHost() {
  const [presented, setPresented] = useState<DialogRequest | null>(null);
  const [options, setOptions] = useState<Record<string, boolean>>({});
  useEffect(() => {
    presentRequest = (request) => {
      setOptions(
        Object.fromEntries(
          (request.request.options ?? []).map((option) => [option.id, option.defaultChecked]),
        ),
      );
      setPresented(request);
    };
    return () => {
      presentRequest = null;
    };
  }, []);

  const handleCancel = useCallback(() => {
    presented?.request.onCancel?.();
    setPresented(null);
  }, [presented]);

  const handleConfirm = useCallback(() => {
    setPresented(null);
    presented?.request.onConfirm(options);
  }, [options, presented]);

  return (
    <Modal
      visible={presented !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={handleCancel}
    >
      {presented === null ? null : (
        <View className="flex-1 items-center justify-center bg-backdrop px-8">
          <View className="w-full rounded-[24px] bg-card px-6 pb-4 pt-5">
            <AppText className="text-lg font-t3-medium">{presented.request.title}</AppText>
            {presented.request.message !== undefined ? (
              <AppText className="mt-2 text-sm text-foreground-secondary">
                {presented.request.message}
              </AppText>
            ) : null}
            {presented.request.options?.map((option) => (
              <View key={option.id} className="mt-3 flex-row items-center justify-between gap-3">
                <AppText className="flex-1 text-sm">{option.label}</AppText>
                <ThemedSwitch
                  accessibilityLabel={option.label}
                  value={options[option.id] ?? option.defaultChecked}
                  onValueChange={(checked) =>
                    setOptions((current) => ({ ...current, [option.id]: checked }))
                  }
                />
              </View>
            ))}
            <View className="mt-5 flex-row justify-end gap-1">
              <View className="overflow-hidden rounded-full">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-10 items-center justify-center px-4 active:bg-subtle"
                  onPress={handleCancel}
                >
                  <AppText className="text-base font-t3-medium">
                    {presented.request.cancelText ?? "Cancel"}
                  </AppText>
                </Pressable>
              </View>
              <View className="overflow-hidden rounded-full">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-10 items-center justify-center px-4 active:bg-subtle"
                  onPress={() => handleConfirm()}
                >
                  <AppText
                    className={cn(
                      "text-base font-t3-medium",
                      presented.request.destructive && "text-danger-foreground",
                    )}
                  >
                    {presented.request.confirmText}
                  </AppText>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      )}
    </Modal>
  );
}
