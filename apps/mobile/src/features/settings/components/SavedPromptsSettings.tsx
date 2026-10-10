import type { SavedPrompt } from "@t3tools/contracts";
import { STARTER_SAVED_PROMPTS } from "@t3tools/shared/savedPrompts";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { uuidv4 } from "../../../lib/uuid";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

function PromptEditor(props: {
  prompt: SavedPrompt;
  disabled: boolean;
  onSave: (prompt: SavedPrompt) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.prompt.name);
  const [text, setText] = useState(props.prompt.text);
  const [behavior, setBehavior] = useState(props.prompt.behavior);
  return (
    <>
      <View className="gap-3 px-4 py-3">
        <AppTextInput
          accessibilityLabel="Prompt name"
          placeholder="Prompt name"
          value={name}
          onChangeText={setName}
          editable={!props.disabled}
          className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        />
        <AppTextInput
          accessibilityLabel="Saved prompt text"
          placeholder="What should the agent do?"
          value={text}
          onChangeText={setText}
          editable={!props.disabled}
          multiline
          className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
        />
      </View>
      <SettingsSwitchRow
        icon="text.bubble"
        label="Send immediately"
        subtitle="When off, insert the text so you can edit and send it."
        value={behavior === "send"}
        onValueChange={(value) => setBehavior(value ? "send" : "insert")}
        disabled={props.disabled}
      />
      <SettingsActionRow
        icon="checkmark"
        label="Save prompt"
        disabled={props.disabled || !name.trim() || !text.trim()}
        onPress={() =>
          props.onSave({ ...props.prompt, name: name.trim(), text: text.trim(), behavior })
        }
      />
      <SettingsActionRow icon="xmark" label="Cancel" onPress={props.onCancel} />
    </>
  );
}

export function SavedPromptsSettings(props: {
  prompts: readonly SavedPrompt[];
  mixed: boolean;
  disabled: boolean;
  onChange: (prompts: readonly SavedPrompt[]) => void;
}) {
  const [editing, setEditing] = useState<SavedPrompt | null>(null);
  const disabled = props.disabled || props.mixed;
  return (
    <SettingsSection title="Saved prompts">
      <Text className="px-4 py-3 text-sm text-foreground-muted">
        Available in every project on the selected environment. Type / in a composer to select one.
      </Text>
      {props.mixed ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          Select one environment to edit its prompts.
        </Text>
      ) : (
        props.prompts.map((prompt) => (
          <View key={prompt.id}>
            <Text className="px-4 pt-3 text-sm text-foreground-muted">
              {prompt.behavior === "send" ? "Send immediately" : "Insert into composer"} ·{" "}
              {prompt.text}
            </Text>
            <SettingsActionRow
              icon="pencil"
              label={prompt.name}
              disabled={disabled}
              onPress={() => setEditing(prompt)}
            />
            <SettingsActionRow
              icon="trash"
              label={`Delete ${prompt.name}`}
              tone="danger"
              disabled={disabled}
              onPress={() =>
                props.onChange(props.prompts.filter((entry) => entry.id !== prompt.id))
              }
            />
          </View>
        ))
      )}
      <SettingsActionRow
        icon="plus"
        label="Add prompt"
        disabled={disabled}
        onPress={() => setEditing({ id: uuidv4(), name: "", text: "", behavior: "insert" })}
      />
      {props.prompts.length === 0 ? (
        <SettingsActionRow
          icon="plus"
          label="Add starter prompts"
          disabled={disabled}
          onPress={() => props.onChange(STARTER_SAVED_PROMPTS)}
        />
      ) : null}
      {editing && !disabled ? (
        <PromptEditor
          key={editing.id}
          prompt={editing}
          disabled={disabled}
          onCancel={() => setEditing(null)}
          onSave={(prompt) => {
            props.onChange(
              props.prompts.some((entry) => entry.id === prompt.id)
                ? props.prompts.map((entry) => (entry.id === prompt.id ? prompt : entry))
                : [...props.prompts, prompt],
            );
            setEditing(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
