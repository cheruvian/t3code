import { useState } from "react";
import { Image, Linking, Modal, Pressable, View } from "react-native";
import { AppText as Text } from "./ui/AppText";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";

export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(
    props.source.kind === "image" ? props.source.selectedIndex : 0,
  );
  const selected =
    props.source.kind === "image" ? props.source.images[selectedIndex] : props.source;
  const uri = selected?.uri;
  return (
    <Modal transparent animationType="fade" onRequestClose={props.onRequestClose}>
      <View className="flex-1 bg-background p-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close preview"
          onPress={props.onRequestClose}
          className="min-h-11 self-end justify-center px-4"
        >
          <Text className="text-foreground">Close</Text>
        </Pressable>
        {props.source.kind === "image" ? (
          <View className="flex-1">
            {uri ? (
              <Image
                source={{ uri }}
                resizeMode="contain"
                style={{ flex: 1 }}
                accessibilityLabel={selected?.name ?? "Image preview"}
              />
            ) : (
              <Text>
                {selected && "failed" in selected && selected.failed
                  ? "Image unavailable"
                  : "Loading image…"}
              </Text>
            )}
            <View className="flex-row justify-between">
              <Pressable
                accessibilityRole="button"
                disabled={selectedIndex === 0}
                onPress={() => setSelectedIndex((index) => index - 1)}
              >
                <Text>Previous image</Text>
              </Pressable>
              <Text>
                {selectedIndex + 1} / {props.source.images.length}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={selectedIndex >= props.source.images.length - 1}
                onPress={() => setSelectedIndex((index) => index + 1)}
              >
                <Text>Next image</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View className="flex-1 items-center justify-center gap-4">
            <Text className="text-foreground">{props.source.name ?? "Document"}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (!uri) return;
                void Linking.openURL(uri).catch(props.onOpenError ?? (() => {}));
              }}
              className="min-h-11 justify-center px-4"
            >
              <Text className="text-primary">Open document</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}
