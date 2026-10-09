import { Image, Linking, Modal, Pressable, View } from "react-native";
import { AppText as Text } from "./AppText";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";

export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
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
          <Image
            source={{ uri: props.source.uri }}
            resizeMode="contain"
            style={{ flex: 1 }}
            accessibilityLabel={props.source.name ?? "Image preview"}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-4">
            <Text className="text-foreground">{props.source.name ?? "Document"}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void Linking.openURL(props.source.uri).catch(props.onOpenError ?? (() => {}));
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
