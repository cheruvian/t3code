import { useEffect, useMemo, useState } from "react";
import { BackHandler, FlatList, Pressable, ScrollView, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerToolbarButton } from "../../components/ComposerToolbar";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import {
  quickCommandGroup,
  quickCommandNavigation,
  shouldDismissQuickPicker,
  type QuickCommandGroup,
} from "./composerQuickCommands";

const GROUPS = [
  { id: "saved", label: "Saved prompts" },
  { id: "commands", label: "Commands" },
  { id: "skills", label: "Skills" },
] as const;

export function ComposerQuickCommandButton(props: {
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <ComposerToolbarButton
      accessibilityLabel="Open slash commands"
      disabled={props.disabled}
      onPress={props.onPress}
      showChevron={false}
      iconNode={<Text className="text-lg font-t3-medium text-foreground">/</Text>}
    />
  );
}

export function ComposerQuickCommandPicker(props: {
  readonly items: readonly ComposerCommandItem[];
  readonly disabled?: boolean;
  readonly canSend: boolean;
  readonly onSelect: (item: ComposerCommandItem, behavior: "insert" | "send") => void;
  readonly onDismiss: () => void;
  readonly onTextbox: () => void;
}) {
  const onDismiss = props.onDismiss;
  const availableGroups = GROUPS.filter((group) =>
    props.items.some((item) => quickCommandGroup(item) === group.id),
  );
  const [navigation, setNavigation] = useState<{ group: QuickCommandGroup; prefixes: string[] }>(
    () => ({ group: availableGroups[0]?.id ?? "commands", prefixes: [] }),
  );
  const [choosingGroup, setChoosingGroup] = useState(false);
  const activeGroup =
    availableGroups.find((group) => group.id === navigation.group) ?? availableGroups[0];
  const prefix = activeGroup?.id === navigation.group ? (navigation.prefixes.at(-1) ?? "") : "";
  const { matches, branches } = useMemo(
    () =>
      quickCommandNavigation(
        props.items.filter((item) => quickCommandGroup(item) === activeGroup?.id),
        prefix,
      ),
    [props.items, activeGroup?.id, prefix],
  );
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onDismiss();
      return true;
    });
    return () => subscription.remove();
  }, [onDismiss]);
  const gestures = useMemo(() => {
    const dismiss = () =>
      Gesture.Pan()
        .activeOffsetY(14)
        .failOffsetX([-14, 14])
        .runOnJS(true)
        .onEnd((event) => {
          if (shouldDismissQuickPicker(event.translationX, event.translationY)) onDismiss();
        });
    return {
      handle: dismiss(),
      // oxlint-disable-next-line react/capitalized-calls -- These factories construct gesture recognizers.
      letters: Gesture.Simultaneous(dismiss(), Gesture.Native()),
    };
  }, [onDismiss]);

  return (
    <View className="rounded-2xl border border-border bg-card px-3 pb-3">
      <GestureDetector gesture={gestures.handle}>
        <View className="h-6 items-center justify-center">
          <View className="h-1 w-9 rounded-full bg-foreground-muted/40" />
        </View>
      </GestureDetector>
      <View className="flex-row items-center gap-1 pb-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose command category"
          accessibilityState={{ expanded: choosingGroup }}
          onPress={() => setChoosingGroup((value) => !value)}
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 active:opacity-60"
        >
          <Text className="shrink text-sm font-t3-medium text-foreground" numberOfLines={1}>
            {activeGroup?.label ?? "Commands"}
          </Text>
          <Text className="text-xs text-foreground-muted">{matches.length}</Text>
          <SymbolView name="chevron.down" size={10} tintColorClassName="accent-icon-muted" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={props.onTextbox}
          className="min-h-11 justify-center px-2 active:opacity-60"
        >
          <Text className="text-xs text-foreground-muted">Textbox</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close command picker"
          onPress={props.onDismiss}
          className="size-11 items-center justify-center active:opacity-60"
        >
          <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      {choosingGroup ? (
        <View className="flex-row gap-1 pb-2">
          {availableGroups.map((group) => (
            <Pressable
              key={group.id}
              accessibilityRole="button"
              accessibilityState={{ selected: group.id === activeGroup?.id }}
              onPress={() => {
                setNavigation({ group: group.id, prefixes: [] });
                setChoosingGroup(false);
              }}
              className="min-h-11 flex-1 items-center justify-center rounded-lg bg-subtle px-2 active:opacity-60"
            >
              <Text className="text-xs text-foreground">{group.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <FlatList
        data={matches}
        keyExtractor={(item) => item.id}
        style={{ height: Math.max(64, Math.min(matches.length, 3) * 64) }}
        initialNumToRender={4}
        windowSize={3}
        keyboardShouldPersistTaps="always"
        ListEmptyComponent={
          <Text className="py-4 text-xs text-foreground-muted">No matching commands.</Text>
        }
        renderItem={({ item }) => {
          const label =
            item.type === "saved-prompt"
              ? item.prompt.name
              : item.type === "skill"
                ? item.skill.name
                : item.label;
          const sendable = item.type !== "slash-command";
          const appliesMode =
            item.type === "slash-command" &&
            (item.command === "plan" || item.command === "default");
          return (
            <View className="h-16 flex-row items-center gap-2 border-b border-border-subtle">
              <Text
                className="min-w-0 flex-1 text-xs text-foreground"
                numberOfLines={2}
                accessibilityHint={item.description}
              >
                {label}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${appliesMode ? "Apply" : "Insert"} ${label}`}
                disabled={props.disabled}
                onPress={() => props.onSelect(item, "insert")}
                className="h-11 min-w-12 items-center justify-center rounded-lg bg-subtle px-2 active:opacity-60 disabled:opacity-40"
              >
                <SymbolView name="arrow.down" size={12} tintColorClassName="accent-icon-muted" />
                <Text className="text-2xs text-foreground">{appliesMode ? "Apply" : "Insert"}</Text>
              </Pressable>
              {sendable ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Send ${label} with current draft`}
                  disabled={props.disabled || !props.canSend}
                  onPress={() => props.onSelect(item, "send")}
                  className="h-11 min-w-12 items-center justify-center rounded-lg bg-primary/15 px-2 active:opacity-60 disabled:opacity-40"
                >
                  <SymbolView name="arrow.up" size={12} tintColorClassName="accent-icon" />
                  <Text className="text-2xs text-foreground">Send</Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
      />
      {prefix ? (
        <View className="flex-row items-center gap-2 pt-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous letter filter"
            onPress={() =>
              setNavigation((current) => ({ ...current, prefixes: current.prefixes.slice(0, -1) }))
            }
            className="size-11 items-center justify-center active:opacity-60"
          >
            <SymbolView name="chevron.left" size={14} tintColorClassName="accent-icon-muted" />
          </Pressable>
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
            {prefix}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset letter filter"
            onPress={() => setNavigation((current) => ({ ...current, prefixes: [] }))}
            className="min-h-11 justify-center px-2 active:opacity-60"
          >
            <Text className="text-xs text-foreground-muted">Reset</Text>
          </Pressable>
        </View>
      ) : null}
      {branches.length > 0 ? (
        <GestureDetector gesture={gestures.letters}>
          <ScrollView
            key={`${activeGroup?.id}:${prefix}`}
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            className="mt-2"
            contentContainerStyle={{ gap: 6 }}
          >
            {branches.map((branch) => (
              <Pressable
                key={branch.letter}
                accessibilityRole="button"
                accessibilityLabel={`${branch.letter.toUpperCase()}, ${branch.count} matches`}
                onPress={() =>
                  setNavigation({
                    group: activeGroup?.id ?? "commands",
                    prefixes: [
                      ...(activeGroup?.id === navigation.group ? navigation.prefixes : []),
                      branch.prefix,
                    ],
                  })
                }
                className="size-12 items-center justify-center rounded-xl bg-subtle active:opacity-60"
              >
                <Text className="text-base font-t3-medium text-foreground">
                  {branch.letter.toUpperCase()}
                </Text>
                <Text className="text-2xs text-foreground-muted">{branch.count}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </GestureDetector>
      ) : null}
    </View>
  );
}
