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
import { AppState, Modal, ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import * as Crypto from "expo-crypto";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EnvironmentIcon } from "../../components/EnvironmentIcon";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProject } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { credentialBroker } from "../../state/credentialBroker";
import { useAtomCommand } from "../../state/use-atom-command";

export function CredentialBrokerCoordinator() {
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
  const [open, setOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const nativeVisible = useRef(false);
  const noticeViews = useRef(new Map<string, ViewInstance>());
  const { height } = useWindowDimensions();
  const [password, setPassword] = useState("");
  const [executable, setExecutable] = useState("bw");
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
  const hasAttention = pending.length > 0 || !!state?.notices.length;
  const [lastPendingId, setLastPendingId] = useState<string>();
  const pendingId = pending[0]?.requestId;
  if (pendingId && pendingId !== lastPendingId) {
    setLastPendingId(pendingId);
    setOpen(true);
  }
  const shown = focused && (open || hasAttention);
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
        label={"Credential access · " + environmentLabel}
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
          if (!pending.length && !state?.notices.length) setOpen(false);
        }}
      >
        <ScrollView
          onScroll={acknowledge}
          scrollEventThrottle={100}
          contentContainerClassName="gap-4 bg-screen px-5 pb-8 pt-16"
        >
          <Text className="text-2xl font-t3-semibold text-foreground">
            {pending.length ? "Credential request" : "Credential access"}
          </Text>
          {pending.length === 0 && (
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
              <TextInput
                secureTextEntry
                autoComplete="off"
                value={password}
                onChangeText={setPassword}
                accessibilityLabel="Bitwarden master password"
                maxLength={4096}
                className="rounded-xl border border-border bg-card px-4 py-3 text-foreground"
              />
              <TextInput
                value={executable}
                onChangeText={setExecutable}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Bitwarden CLI executable"
                className="rounded-xl border border-border bg-card px-4 py-3 text-foreground"
              />
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
                {notice.revoked ? "Permission revoked" : "Saved login used automatically"}
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
          {pending.map((request) => (
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
          {state?.requests
            .filter((r) => ["running", "preparing", "saving"].includes(r.state))
            .map((request) => (
              <View key={request.requestId} className="gap-2">
                <Text className="text-foreground">
                  {request.site} · {request.state}
                </Text>
                <Button
                  label="Stop"
                  tone="danger"
                  disabled={!canAct}
                  onPress={() => void act({ type: "stop", requestId: request.requestId })}
                />
              </View>
            ))}
          {pending.length > 0 && (
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
          {(managementOpen || pending.length === 0) && (
            <>
              {state?.grants.map((grant) => (
                <View key={grant.grantId} className="gap-2 rounded-xl border border-border p-4">
                  <Text className="text-foreground">
                    {grant.site} · {grant.field} · {grant.maxTtl}s maximum
                  </Text>
                  <Text selectable className="text-xs text-foreground-muted">
                    {JSON.stringify(
                      {
                        thread: grant.threadId,
                        executable: grant.argv[0],
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
  environmentId,
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
  const environment = environments.find((e) => e.environmentId === request.origin?.environmentId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [chosenId, setSelection] = useState<string | undefined>(undefined);
  const selection = request.candidates.some((candidate) => candidate.id === chosenId)
    ? chosenId
    : request.candidates.length === 1
      ? request.candidates[0]!.id
      : undefined;
  return (
    <View className="gap-2 rounded-xl border border-border p-3">
      <Text className="text-xs text-foreground-muted">
        {request.field === "login"
          ? "Username + password"
          : request.field === "password"
            ? "Password"
            : "Username"}{" "}
        requested for
      </Text>
      <Text className="text-xl font-t3-semibold text-foreground">{request.site}</Text>
      <Text className="text-xs text-foreground-muted">
        {request.ttlSeconds}s access after approval
      </Text>
      <View className="gap-2 rounded-xl bg-card p-3">
        <Text className="text-xs text-foreground-muted">
          {request.origin ? "Caller verified by T3" : "Unverified caller"}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <Text className="text-foreground">Project:</Text>
          {project && (
            <ProjectFavicon
              environmentId={project.environmentId}
              projectTitle={project.title}
              workspaceRoot={project.workspaceRoot}
              faviconPath={project.faviconPath}
              projectIcon={project.projectIcon}
              size={16}
            />
          )}
          <Text className="flex-1 text-foreground">
            {request.origin?.projectName || "Not available"}
          </Text>
        </View>
        <Text className="text-foreground">
          Thread: {request.origin?.threadTitle || "No verified T3 thread"}
        </Text>
        <Text className="text-foreground">
          Agent:{" "}
          {request.origin
            ? `${request.origin.agent} · ${request.origin.providerInstanceId}`
            : "Not verified"}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <Text className="text-foreground">Environment:</Text>
          <EnvironmentIcon
            environmentId={environmentId}
            kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
            size={16}
            tintColorClassName="accent-icon"
          />
          <Text className="flex-1 text-foreground">{environmentLabel}</Text>
        </View>
        <Text className="text-foreground">Program: {request.argv[0]?.split(/[\\/]/).at(-1)}</Text>
      </View>
      <Text className="text-sm text-foreground-muted">Reason supplied by agent</Text>
      <Text className="text-foreground">{request.reason}</Text>
      {request.state !== "pending" ? (
        <Text accessibilityLiveRegion="polite" className="text-foreground-muted">
          {request.state === "searching"
            ? request.searchPhase === "syncing"
              ? "Loading saved accounts… Syncing Bitwarden. You can deny this request while you wait."
              : "Loading saved accounts… Searching Bitwarden. You can deny this request while you wait."
            : "Unlock the vault to choose a login. Access still needs your approval."}
        </Text>
      ) : (
        <>
          {request.candidates.length === 0 && (
            <Text accessibilityLiveRegion="polite" className="text-foreground-muted">
              {request.error
                ? "No accounts available for approval."
                : "No matching accounts found."}
            </Text>
          )}
          {request.candidates.length > 0 && (
            <Text className="text-foreground-muted">
              {request.candidates.length} matching accounts · Choose a login to approve
            </Text>
          )}
          {request.candidates.map((c) => (
            <Button
              key={c.id}
              label={
                (selection === c.id ? "✓ " : "") +
                c.name +
                " · " +
                (c.username ?? "Username unavailable") +
                " · " +
                c.hosts.join(", ")
              }
              disabled={disabled}
              onPress={() => setSelection(c.id)}
            />
          ))}
        </>
      )}
      {request.browser ? (
        <Text className="text-xs text-foreground-muted">
          Browser · {request.browser.origin} · {request.browser.profile}
        </Text>
      ) : null}
      {request.error && (
        <Text accessibilityRole="alert" className="text-danger">
          {request.error}
        </Text>
      )}
      {request.canSave && request.state === "pending" && (
        <SaveLogin request={request} disabled={disabled} act={act} />
      )}
      {request.browser ? (
        <ManualBrowserLogin request={request} disabled={disabled} act={act} />
      ) : null}
      <Button
        label={detailsOpen ? "Hide command & scope" : "Command, workspace & permission scope"}
        tone="text"
        onPress={() => setDetailsOpen(!detailsOpen)}
      />
      {detailsOpen && (
        <>
          <Text selectable className="text-xs text-foreground">
            {JSON.stringify(
              {
                executable: request.argv[0],
                arguments: request.argv.slice(1),
                directory: request.cwd,
                labelClaim: request.label,
                reason: request.reason,
                callerClaim: request.clientClaim,
                origin: request.origin,
              },
              null,
              2,
            )}
          </Text>
          <Text className="text-xs text-foreground-muted">
            Always allow scopes this login to the thread, provider, workspace, exact command,
            fingerprints, fields, and maximum lifetime. Review or revoke it under Manage access.
          </Text>
        </>
      )}
      <Text className="text-xs text-foreground-muted">
        {request.approvalDeadline === null
          ? "Waits for your decision · no approval timeout"
          : `Approval expires ${new Date(request.approvalDeadline).toLocaleTimeString()}`}
      </Text>
      <Button
        label="Deny"
        tone="text"
        disabled={disabled}
        onPress={() => void act({ type: "decide", requestId: request.requestId, decision: "deny" })}
      />
      <Button
        label="Allow once"
        tone="primary"
        disabled={disabled || request.state !== "pending" || !selection}
        onPress={() =>
          void act({
            type: "decide",
            requestId: request.requestId,
            decision: "once",
            candidateId: selection!,
          })
        }
      />
      <Button
        label="Always allow"
        disabled={disabled || request.state !== "pending" || !selection || !request.origin}
        onPress={() =>
          void act({
            type: "decide",
            requestId: request.requestId,
            decision: "always",
            candidateId: selection!,
          })
        }
      />
    </View>
  );
}

function ManualBrowserLogin({
  request,
  disabled,
  act,
}: {
  request: CredentialApproval;
  disabled: boolean;
  act: (input: CredentialBrokerAction) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const username = useRef("");
  const password = useRef("");
  const usernameInput = useRef<TextInputInstance>(null);
  const passwordInput = useRef<TextInputInstance>(null);
  return (
    <View className="gap-2">
      <Button
        label={open ? "Hide private login" : "Enter a login privately"}
        tone="text"
        disabled={disabled || busy}
        onPress={() => {
          username.current = "";
          password.current = "";
          usernameInput.current?.clear();
          passwordInput.current?.clear();
          setOpen(!open);
        }}
      />
      {open ? (
        <>
          <Text className="text-xs text-foreground-muted">
            Use once in browser profile {request.browser?.profile}. Values stay out of chat and are
            not saved in Bitwarden.
          </Text>
          <TextInput
            ref={usernameInput}
            accessibilityLabel="Private browser username"
            placeholder="Username or email"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled && !busy}
            onChangeText={(value) => {
              username.current = value;
            }}
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <TextInput
            ref={passwordInput}
            accessibilityLabel="Private browser password"
            placeholder="Password"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled && !busy}
            onChangeText={(value) => {
              password.current = value;
            }}
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <Button
            label={busy ? "Signing in…" : "Sign in once"}
            disabled={disabled || busy}
            onPress={() => {
              if (!username.current || !password.current) return;
              const login = { username: username.current, password: password.current };
              username.current = "";
              password.current = "";
              usernameInput.current?.clear();
              passwordInput.current?.clear();
              setBusy(true);
              void act({ type: "browserManual", requestId: request.requestId, ...login }).finally(
                () => setBusy(false),
              );
            }}
          />
        </>
      ) : null}
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
  const [open, setOpen] = useState(request.candidates.length === 0);
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
      <Button
        label={open ? "Hide new login" : "Enter and save a new login"}
        tone="text"
        disabled={disabled || busy}
        onPress={() => {
          clear();
          setOpen(!open);
        }}
      />
      {open && (
        <>
          <Text className="text-xs text-foreground-muted">
            Create a new Bitwarden login for {request.site} and share it once with this program.
            Enter the site password, not your vault master password. Values stay out of chat.
          </Text>
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
        </>
      )}
    </View>
  );
}
