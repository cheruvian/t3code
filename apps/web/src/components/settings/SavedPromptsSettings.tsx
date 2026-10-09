import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import type { SavedPrompt } from "@t3tools/contracts";
import { STARTER_SAVED_PROMPTS } from "@t3tools/shared/savedPrompts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function SavedPromptEditor(props: {
  prompt: SavedPrompt;
  onSave: (prompt: SavedPrompt) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.prompt.name);
  const [text, setText] = useState(props.prompt.text);
  const [behavior, setBehavior] = useState(props.prompt.behavior);
  return (
    <div className="grid gap-3">
      <Input
        aria-label="Prompt name"
        placeholder="Prompt name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Textarea
        aria-label="Saved prompt text"
        placeholder="What should the agent do?"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <SettingsRow
        title="Send immediately"
        description="When off, selecting this prompt inserts its text for you to edit and send."
        control={
          <Switch
            checked={behavior === "send"}
            onCheckedChange={(checked) => setBehavior(checked ? "send" : "insert")}
            aria-label="Send saved prompt immediately"
          />
        }
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!name.trim() || !text.trim()}
          onClick={() =>
            props.onSave({ ...props.prompt, name: name.trim(), text: text.trim(), behavior })
          }
        >
          Save prompt
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function SavedPromptsSettings() {
  const { scope, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const mixed = useScopedSettingsMixed(["savedPrompts"]);
  const updateSettings = useUpdateScopedSettings();
  const [editing, setEditing] = useState<SavedPrompt | null>(null);
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  const prompts = settings.savedPrompts;
  const disabled = !canWriteSettings || targets.length === 0 || mixed;
  return (
    <SettingsSection id="saved-prompts" title="Saved prompts">
      <SettingsRow
        serverScoped
        settingKeys={["savedPrompts"]}
        mixed={mixed}
        title="Prompts for every project"
        description="Type / in any composer to select a saved prompt. Each prompt can insert its text or send immediately."
        control={
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                setEditing({ id: randomUUID(), name: "", text: "", behavior: "insert" })
              }
            >
              Add prompt
            </Button>
            {prompts.length === 0 ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => updateSettings({ savedPrompts: STARTER_SAVED_PROMPTS })}
              >
                Add starter prompts
              </Button>
            ) : null}
          </div>
        }
      />
      {mixed ? (
        <SettingsRow
          title="Different prompts across environments"
          description="Select one environment to edit its prompts."
        />
      ) : (
        prompts.map((prompt) => (
          <SettingsRow
            key={prompt.id}
            title={prompt.name}
            description={`${prompt.behavior === "send" ? "Send immediately" : "Insert into composer"} · ${prompt.text}`}
            control={
              <div className="flex gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => setEditing(prompt)}
                >
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    updateSettings({
                      savedPrompts: prompts.filter((entry) => entry.id !== prompt.id),
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            }
          />
        ))
      )}
      {editing && !disabled ? (
        <SettingsRow
          title={prompts.some((prompt) => prompt.id === editing.id) ? "Edit prompt" : "New prompt"}
        >
          <SavedPromptEditor
            key={editing.id}
            prompt={editing}
            onCancel={() => setEditing(null)}
            onSave={(prompt) => {
              updateSettings({
                savedPrompts: prompts.some((entry) => entry.id === prompt.id)
                  ? prompts.map((entry) => (entry.id === prompt.id ? prompt : entry))
                  : [...prompts, prompt],
              });
              setEditing(null);
            }}
          />
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
