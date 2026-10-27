import {
  credentialDialogAttentionKey,
  reconcileCredentialDialog,
  type CredentialDialogPresentation,
} from "@t3tools/client-runtime/state/credentialBroker";
import type { ViewInstance, TextInputInstance } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessReadScope,
  resolveEnvironmentMachineKind,
  type CredentialApproval,
  type CredentialBrokerAction,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import * as Crypto from "expo-crypto";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { useProject } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { credentialBroker } from "../../state/credentialBroker";
import { useAtomCommand } from "../../state/use-atom-command";

export function CredentialBrokerCoordinator({
  viewedThread,
}: {
  readonly viewedThread: { readonly environmentId: string; readonly threadId: string } | null;
}) {
  const { environments } = useEnvironments();
  const [active, setActive] = useState<EnvironmentId>();
  const attention = useRef(new Set<EnvironmentId>());
  const report = useCallback((id: EnvironmentId, hasAttention: boolean) => {
    if (hasAttention) attention.current.add(id);
    else attention.current.delete(id);
    setActive((current) =>
      current && attention.current.has(current)
        ? current
        : (attention.current.values().next().value ?? current),
    );
  }, []);
  return (
    <View pointerEvents="box-none" className="absolute bottom-4 right-4 gap-2">
      {environments.map((e) => (
        <AuthorizedBroker
          key={e.environmentId}
          environmentId={e.environmentId}
          environmentLabel={e.label}
          focused={active === e.environmentId}
          viewedThread={viewedThread}
          select={() => setActive(e.environmentId)}
          report={report}
        />
      ))}
    </View>
  );
}
type BrokerProps = {
  environmentId: EnvironmentId;
  environmentLabel: string;
  focused: boolean;
  viewedThread: { readonly environmentId: string; readonly threadId: string } | null;
  select: () => void;
  report: (id: EnvironmentId, attention: boolean) => void;
};
function AuthorizedBroker(props: BrokerProps) {
  return useEnvironmentScope(props.environmentId, AuthAccessReadScope) ? (
    <EnvironmentBroker {...props} />
  ) : null;
}
function EnvironmentBroker({
  environmentId,
  environmentLabel,
  focused,
  viewedThread,
  select,
  report,
}: BrokerProps) {
  const [viewId] = useState(() => Crypto.randomUUID());
  const result = useAtomValue(credentialBroker.state({ environmentId, input: { viewId } }));
  const run = useAtomCommand(credentialBroker.action, {
    reportFailure: false,
    reportDefect: false,
  });
  const canAct = useAtomValue(credentialBroker.action.permissionAtom(environmentId));
  const state = AsyncResult.isSuccess(result) ? result.value : undefined;
  const viewKey = JSON.stringify(viewedThread);
  const [presentation, setPresentation] = useState<CredentialDialogPresentation>({
    viewKey,
    attentionKey: null,
    open: false,
  });
  const [managementOpen, setManagementOpen] = useState(false);
  const nativeVisible = useRef(false);
  const noticeViews = useRef(new Map<string, ViewInstance>());
  const { height } = useWindowDimensions();
  const [password, setPassword] = useState("");
  const [executable, setExecutable] = useState("bw");
  const [advancedUnlock, setAdvancedUnlock] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (input: CredentialBrokerAction) => {
    const outcome = await run({ environmentId, input });
    setError(
      outcome._tag === "Failure"
        ? "Could not complete the action. Check connection, permissions, and vault status."
        : undefined,
    );
  };
  useEffect(() => {
    if (!state?.status || !canAct) return;
    const publish = (status: string) => {
      void run({
        environmentId,
        input: { type: "presenter", viewId, visible: status === "active" },
      });
    };
    publish(AppState.currentState ?? "unknown");
    const subscription = AppState.addEventListener("change", publish);
    return () => subscription.remove();
  }, [state?.status, canAct, environmentId, run, viewId]);
  const pending =
    state?.requests.filter((r) => ["pending", "awaiting_unlock", "searching"].includes(r.state)) ??
    [];
  const active =
    state?.requests.filter((r) => ["running", "preparing", "saving"].includes(r.state)) ?? [];
  const hasRequests = pending.length + active.length > 0;
  const locked = state?.status === "locked" || state?.status === "unlocking";
  const attentionKey =
    credentialDialogAttentionKey(pending, environmentId, viewedThread) ??
    (state?.notices.length ? JSON.stringify(state.notices.map((notice) => notice.noticeId)) : null);
  const nextPresentation = reconcileCredentialDialog(presentation, viewKey, attentionKey);
  if (nextPresentation !== presentation) setPresentation(nextPresentation);
  const open = nextPresentation.open;
  const setOpen = (open: boolean) => setPresentation({ ...nextPresentation, open });
  const hasAttention = open;
  const shown = focused && open;
  useEffect(() => {
    report(environmentId, hasAttention);
    return () => report(environmentId, false);
  }, [environmentId, hasAttention, report]);
  useEffect(() => {
    if (!shown) nativeVisible.current = false;
  }, [shown]);
  const acknowledged = useRef(new Set<string>());
  // Native onShow is the visibility acknowledgment; hidden/background clients cannot deliver automatically.
  const acknowledge = () => {
    if (AppState.currentState !== "active" || !canAct || !nativeVisible.current) return;
    for (const notice of state?.notices ?? []) {
      if (acknowledged.current.has(notice.noticeId)) continue;
      noticeViews.current.get(notice.noticeId)?.measureInWindow((_x, y, _width, noticeHeight) => {
        if (
          y >= 0 &&
          y + noticeHeight <= height &&
          nativeVisible.current &&
          AppState.currentState === "active"
        ) {
          acknowledged.current.add(notice.noticeId);
          void run({ environmentId, input: { type: "seen", viewId, noticeId: notice.noticeId } });
        }
      });
    }
  };
  return (
    <>
      <Button
        label={
          "Credential access · " +
          environmentLabel +
          (pending.length ? ` · ${pending.length} waiting` : "")
        }
        onPress={() => {
          select();
          setOpen(true);
        }}
      />
      <Modal
        visible={shown}
        animationType="none"
        onShow={() => {
          nativeVisible.current = true;
          acknowledge();
        }}
        onDismiss={() => {
          nativeVisible.current = false;
        }}
        onRequestClose={() => {
          setOpen(false);
        }}
      >
        <ScrollView
          onScroll={acknowledge}
          scrollEventThrottle={100}
          contentContainerClassName="gap-4 bg-screen px-5 pb-8 pt-16"
        >
          <Button label={hasRequests ? "Hide for now" : "Close"} onPress={() => setOpen(false)} />
          <Text className="text-2xl font-t3-semibold text-foreground">
            {locked ? "Unlock Bitwarden" : hasRequests ? "Credential request" : "Credential access"}
          </Text>
          {!hasRequests && (
            <Text className="text-sm text-foreground-muted">{environmentLabel}</Text>
          )}
          <Text className="text-sm text-foreground-muted">
            Credentials go directly to the approved program.
          </Text>
          {error && (
            <Text accessibilityRole="alert" className="text-danger">
              {error}
            </Text>
          )}
          {state?.error && <Text className="text-danger">{state.error}</Text>}
          {state?.status === "unsupported" && (
            <Text className="text-foreground">Windows security adapters are not supported.</Text>
          )}
          {(state?.status === "locked" || state?.status === "unlocking") && (
            <View className="gap-3">
              <Text className="text-foreground">
                Unlock Bitwarden privately. Its CLI must be signed in on the server.
              </Text>
              <Text className="text-sm text-foreground">Bitwarden master password</Text>
              <TextInput
                secureTextEntry
                autoComplete="off"
                value={password}
                onChangeText={setPassword}
                accessibilityLabel="Bitwarden master password"
                maxLength={4096}
                className="rounded-xl border border-border bg-card px-4 py-3 text-foreground"
              />
              <Button
                label={advancedUnlock ? "Hide advanced setup" : "Advanced setup"}
                tone="text"
                onPress={() => setAdvancedUnlock(!advancedUnlock)}
              />
              {advancedUnlock && (
                <TextInput
                  value={executable}
                  onChangeText={setExecutable}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Bitwarden CLI executable"
                  className="rounded-xl border border-border bg-card px-4 py-3 text-foreground"
                />
              )}
              <Button
                label="Unlock vault"
                disabled={!canAct || state.status === "unlocking"}
                onPress={() => {
                  const value = password;
                  setPassword("");
                  void act({ type: "unlock", password: value, executable });
                }}
              />
            </View>
          )}
          {state?.notices.map((notice) => (
            <View
              key={notice.noticeId}
              ref={(view) => {
                if (view) noticeViews.current.set(notice.noticeId, view);
                else noticeViews.current.delete(notice.noticeId);
              }}
              className="gap-3 rounded-2xl border border-border p-4"
              onLayout={acknowledge}
            >
              <Text className="font-t3-medium text-foreground">
                {notice.revoked ? "Permission revoked" : "Saved credential used automatically"}
              </Text>
              <Text className="text-foreground-muted">
                {notice.site} · {notice.command}
              </Text>
              <Text className="text-xs text-foreground-muted">
                Notice available until {new Date(notice.expiresAt).toLocaleTimeString()}
              </Text>
              <Button
                label="Dismiss"
                disabled={!canAct}
                onPress={() => void act({ type: "dismiss", noticeId: notice.noticeId })}
              />
              <Button
                label="Revoke & stop"
                tone="danger"
                disabled={!canAct || notice.revoked}
                onPress={() => void act({ type: "revoke", grantId: notice.grantId })}
              />
            </View>
          ))}
          {!locked &&
            [...pending, ...active]
              .sort(
                (a, b) =>
                  Number(b.origin?.threadId === viewedThread?.threadId) -
                  Number(a.origin?.threadId === viewedThread?.threadId),
              )
              .map((request) => (
                <Approval
                  key={request.requestId}
                  request={request}
                  environmentId={environmentId}
                  environmentLabel={environmentLabel}
                  disabled={!canAct}
                  act={act}
                />
              ))}
          {state?.requests
            .filter((r) =>
              ["expired", "failed", "denied", "completed", "released", "revoked"].includes(r.state),
            )
            .slice(0, 3)
            .map((request) => (
              <Text
                key={request.requestId}
                accessibilityLiveRegion="polite"
                className="text-foreground-muted"
              >
                {request.site} ·{" "}
                {request.state === "expired"
                  ? "Request expired. Ask the agent for a new request to continue."
                  : (request.error ?? `Request ${request.state}.`)}
              </Text>
            ))}
          {hasRequests && (
            <Button
              label={
                managementOpen
                  ? "Hide access management"
                  : `Manage access · ${state?.grants.length ?? 0} saved permissions`
              }
              tone="text"
              onPress={() => setManagementOpen(!managementOpen)}
            />
          )}
          {(managementOpen || (!hasRequests && !locked)) && (
            <>
              {state?.grants.map((grant) => (
                <View key={grant.grantId} className="gap-2 rounded-xl border border-border p-4">
                  <Text className="text-foreground">
                    {grant.site} · {grant.field === "sshKey" ? "SSH private key" : grant.field} ·{" "}
                    {grant.maxTtl}s maximum
                  </Text>
                  <Text selectable className="text-xs text-foreground-muted">
                    {JSON.stringify(
                      {
                        thread: grant.threadId,
                        executable: grant.argv[0],
                        invocationName: grant.argv0,
                        arguments: grant.argv.slice(1),
                        directory: grant.cwd,
                      },
                      null,
                      2,
                    )}
                  </Text>
                  <Button
                    label="Revoke & stop"
                    tone="danger"
                    disabled={!canAct}
                    onPress={() => void act({ type: "revoke", grantId: grant.grantId })}
                  />
                </View>
              ))}
              {state?.status === "ready" && (
                <Button
                  label="Lock vault & stop access"
                  disabled={!canAct}
                  onPress={() => void act({ type: "lock" })}
                />
              )}
              <Text className="text-xs text-foreground-muted">
                Revocation stops supervised programs and deletes credential files. It cannot erase
                copied secrets or end an established website session.
              </Text>
            </>
          )}
          {!pending.length && !state?.notices.length && (
            <Button label="Close" onPress={() => setOpen(false)} />
          )}
        </ScrollView>
      </Modal>
    </>
  );
}
function Approval({
  request,
  environmentLabel,
  disabled,
  act,
}: {
  environmentId: EnvironmentId;
  request: CredentialApproval;
  environmentLabel: string;
  disabled: boolean;
  act: (input: CredentialBrokerAction) => Promise<void>;
}) {
  const project = useProject(
    request.origin?.projectId
      ? { environmentId: request.origin.environmentId, projectId: request.origin.projectId }
      : null,
  );
  const { environments } = useEnvironments();
  const environment = environments.find(
    (entry) => entry.environmentId === request.origin?.environmentId,
  );
  const callerLabel = request.origin
    ? [request.origin.projectName, request.origin.threadTitle].filter(Boolean).join(" · ")
    : "Unverified caller";
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [chosenId, setSelection] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const selection = request.candidates.some((c) => c.id === chosenId)
    ? chosenId
    : request.searchQuery === undefined && request.candidates.length === 1
      ? request.candidates[0]!.id
      : undefined;
  const selected = request.candidates.find((c) => c.id === selection);
  const canAlways = !!request.origin && (!selected?.hostMismatch || request.canSaveHost === true);
  const unavailable = disabled || submitting || request.state !== "pending";
  const processing = ["preparing", "saving", "running"].includes(request.state);
  const submit = async (choice: "once" | "always" | "deny") => {
    if (disabled || submitting) return;
    setSubmitting(true);
    try {
      await act({
        type: "decide",
        requestId: request.requestId,
        decision: choice,
        ...(choice !== "deny" && selection ? { candidateId: selection } : {}),
      });
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text className="text-xl font-t3-semibold text-foreground">{request.site}</Text>
        <View className="flex-row flex-wrap items-center gap-1.5">
          {project ? (
            <ProjectFavicon
              environmentId={project.environmentId}
              projectTitle={project.title}
              workspaceRoot={project.workspaceRoot}
              faviconPath={project.faviconPath}
              projectIcon={project.projectIcon}
              size={16}
            />
          ) : null}
          {callerLabel ? (
            <Text className="text-sm text-foreground-muted">{callerLabel} ·</Text>
          ) : null}
          <EnvironmentMachineSymbol
            kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
            size={16}
            tintColorClassName="accent-icon"
          />
          <Text className="text-sm text-foreground-muted">{environmentLabel}</Text>
        </View>
        <Text className="text-foreground">{request.reason}</Text>
        <Text className="text-xs text-foreground-muted">{request.ttlSeconds}s per use</Text>
      </View>
      {processing ? (
        <View className="gap-3 rounded-xl bg-card p-4">
          <Text accessibilityLiveRegion="polite" className="font-t3-medium text-foreground">
            {request.state === "running"
              ? "Program is running"
              : request.state === "saving"
                ? "Saving credential to Bitwarden…"
                : "Preparing approved access…"}
          </Text>
          <Text className="text-foreground-muted">
            You can keep working. Stop ends this operation and removes temporary credential access.
          </Text>
          <Button
            label="Stop operation"
            tone="danger"
            disabled={disabled}
            onPress={() => void act({ type: "stop", requestId: request.requestId })}
          />
        </View>
      ) : request.state === "awaiting_unlock" ? (
        <Text className="text-foreground-muted">
          Unlock Bitwarden to choose a credential for this request.
        </Text>
      ) : (
        <>
          <View className="gap-3">
            <View className="flex-row items-center justify-between gap-2">
              <Text className="font-t3-medium text-foreground">
                {adding ? "New login" : request.field === "sshKey" ? "SSH key" : "Saved credential"}
              </Text>
              {request.canSave && (
                <Button
                  label={adding ? "Choose saved credential" : "Add credential"}
                  tone="text"
                  disabled={unavailable}
                  onPress={() => setAdding(!adding)}
                />
              )}
            </View>
            {adding ? (
              <SaveLogin request={request} disabled={disabled || submitting} act={act} />
            ) : (
              <>
                {request.canSearch && (
                  <VaultSearch
                    key={request.searchQuery}
                    request={request}
                    disabled={unavailable || !!request.grantId}
                    search={(query) => {
                      setSelection(undefined);
                      void act({
                        type: "search",
                        requestId: request.requestId,
                        ...(query !== undefined ? { query } : {}),
                      });
                    }}
                  />
                )}
                {request.state === "searching" ? (
                  <Text accessibilityLiveRegion="polite" className="py-3 text-foreground-muted">
                    {request.searchPhase === "syncing"
                      ? "Syncing Bitwarden…"
                      : "Finding credentials…"}
                  </Text>
                ) : request.candidates.length ? (
                  <ScrollView
                    className="max-h-56 rounded-xl border border-border"
                    nestedScrollEnabled
                  >
                    <View accessibilityRole="radiogroup">
                      {request.candidates.map((c) => (
                        <Pressable
                          key={c.id}
                          accessibilityRole="radio"
                          accessibilityState={{
                            checked: selection === c.id,
                            disabled: disabled || submitting,
                          }}
                          accessibilityLabel={[
                            c.name,
                            c.username,
                            c.hosts.join(", ") || "No saved host",
                            c.hostMismatch ? "Host does not match" : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          disabled={disabled || submitting}
                          onPress={() => setSelection(c.id)}
                          className={selection === c.id ? "gap-1 bg-card p-3" : "gap-1 p-3"}
                        >
                          <Text className="font-t3-medium text-foreground">
                            {selection === c.id ? "✓ " : ""}
                            {c.name}
                          </Text>
                          <Text className="text-xs text-foreground-muted">
                            {[c.username, c.hosts.join(", ") || "No saved host"]
                              .filter(Boolean)
                              .join(" · ")}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </ScrollView>
                ) : (
                  !request.error && (
                    <Text className="text-foreground-muted">
                      No credentials found. Search all Bitwarden or add a login.
                    </Text>
                  )
                )}
              </>
            )}
            {request.error && (
              <Text accessibilityRole="alert" className="text-danger">
                {request.error}
              </Text>
            )}
          </View>
          {!adding && (
            <>
              <Text className="text-xs text-foreground-muted">
                {selected?.hostMismatch
                  ? `Always allow also saves ${request.site} to this credential in Bitwarden. Existing hosts are kept.`
                  : "Always allow remembers access for this thread, credential, and command. Revoke anytime in Manage access."}
              </Text>
              <View className="flex-row flex-wrap justify-end gap-2">
                <Button
                  label="Deny"
                  tone="text"
                  disabled={disabled || submitting}
                  onPress={() => void submit("deny")}
                />
                <Button
                  label="Always allow"
                  tone="secondary"
                  disabled={unavailable || !selection || !canAlways}
                  onPress={() => void submit("always")}
                />
                <Button
                  label="Allow once"
                  tone="primary"
                  loading={submitting}
                  disabled={unavailable || !selection}
                  onPress={() => void submit("once")}
                />
              </View>
            </>
          )}
        </>
      )}
      <Button
        label={detailsOpen ? "Hide request details" : "Request details"}
        tone="text"
        onPress={() => setDetailsOpen(!detailsOpen)}
      />
      {detailsOpen && (
        <Text selectable className="text-xs text-foreground-muted">
          {JSON.stringify(
            {
              agent: request.origin?.agent,
              executable: request.argv[0],
              arguments: request.argv.slice(1),
              directory: request.cwd,
              fields: request.field,
              lifetimeSeconds: request.ttlSeconds,
            },
            null,
            2,
          )}
        </Text>
      )}
    </View>
  );
}

function VaultSearch({
  request,
  disabled,
  search,
}: {
  request: CredentialApproval;
  disabled: boolean;
  search: (query?: string) => void;
}) {
  const [query, setQuery] = useState(request.searchQuery ?? "");
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground">Search Bitwarden</Text>
      <TextInput
        accessibilityLabel="Search Bitwarden by name, username, or host"
        value={query}
        onChangeText={setQuery}
        editable={!disabled}
        maxLength={200}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Name, username, or host"
        className="rounded-xl border border-border px-3 py-2 text-foreground"
        returnKeyType="search"
        onSubmitEditing={() => {
          if (!disabled) search(query);
        }}
      />
      <Button label="Search" disabled={disabled} onPress={() => search(query)} />
      <Text className="text-xs text-foreground-muted">
        Search all saved credentials, even when the host differs. Leave blank to browse.
      </Text>
      {request.searchQuery !== undefined && (
        <Button
          label="Use hostname matches"
          tone="text"
          disabled={disabled}
          onPress={() => search()}
        />
      )}
    </View>
  );
}

function SaveLogin({
  request,
  disabled,
  act,
}: {
  request: CredentialApproval;
  disabled: boolean;
  act: (input: CredentialBrokerAction) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const username = useRef("");
  const password = useRef("");
  const usernameInput = useRef<TextInputInstance>(null);
  const passwordInput = useRef<TextInputInstance>(null);
  const clear = () => {
    username.current = "";
    password.current = "";
    usernameInput.current?.clear();
    passwordInput.current?.clear();
  };
  return (
    <View className="gap-2">
      <Text className="text-xs text-foreground-muted">
        Create a new Bitwarden login for {request.site} and share it once with this program. Enter
        the site password, not your vault master password. Values stay out of chat.
      </Text>
      <Text className="text-sm text-foreground">Username or email</Text>
      <TextInput
        ref={usernameInput}
        accessibilityLabel="New login username"
        placeholder="Username or email"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={4096}
        editable={!disabled && !busy}
        onChangeText={(value) => {
          username.current = value;
        }}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      <Text className="text-sm text-foreground">Site password</Text>
      <TextInput
        ref={passwordInput}
        accessibilityLabel="New login password"
        placeholder="Site password"
        secureTextEntry
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={4096}
        editable={!disabled && !busy}
        onChangeText={(value) => {
          password.current = value;
        }}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      <Button
        label={busy ? "Saving…" : "Save to Bitwarden & allow once"}
        disabled={disabled || busy}
        onPress={() => {
          if (
            disabled ||
            busy ||
            (request.field !== "password" && !username.current) ||
            (request.field !== "username" && !password.current)
          )
            return;
          const login = { username: username.current, password: password.current };
          clear();
          setBusy(true);
          void act({ type: "saveLogin", requestId: request.requestId, ...login }).finally(() =>
            setBusy(false),
          );
        }}
      />
    </View>
  );
}
