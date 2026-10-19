import type { ViewInstance } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessReadScope,
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
      current && attention.current.has(current) ? current : attention.current.values().next().value,
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
    state?.requests.filter((r) => ["pending", "awaiting_unlock"].includes(r.state)) ?? [];
  const hasAttention = pending.length > 0 || !!state?.notices.length;
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
              environmentLabel={environmentLabel}
              disabled={!canAct}
              act={act}
            />
          ))}
          {state?.requests
            .filter((r) => ["running", "preparing"].includes(r.state))
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
  request,
  environmentLabel,
  disabled,
  act,
}: {
  request: CredentialApproval;
  environmentLabel: string;
  disabled: boolean;
  act: (input: CredentialBrokerAction) => Promise<void>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selection, setSelection] = useState<string | undefined>(
    request.candidates.length === 1 ? request.candidates[0]!.id : undefined,
  );
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
        <Text className="text-foreground">
          Project: {request.origin?.projectName || "Not available"}
        </Text>
        <Text className="text-foreground">
          Thread: {request.origin?.threadTitle || "No verified T3 thread"}
        </Text>
        <Text className="text-foreground">
          Agent:{" "}
          {request.origin
            ? `${request.origin.agent} · ${request.origin.providerInstanceId}`
            : "Not verified"}
        </Text>
        <Text className="text-foreground">Environment: {environmentLabel}</Text>
        <Text className="text-foreground">Program: {request.argv[0]?.split(/[\\/]/).at(-1)}</Text>
      </View>
      <Text className="text-sm text-foreground-muted">Reason supplied by agent</Text>
      <Text numberOfLines={2} className="text-foreground">
        {request.reason}
      </Text>
      {request.state === "awaiting_unlock" ? (
        <Text className="text-foreground-muted">
          Unlock the vault to choose a login. Access still needs your approval.
        </Text>
      ) : (
        <>
          <Text className="text-foreground-muted">Saved login</Text>
          {request.candidates.map((c) => (
            <Button
              key={c.id}
              label={(selection === c.id ? "✓ " : "") + c.name + " · " + c.hosts.join(", ")}
              disabled={disabled}
              onPress={() => setSelection(c.id)}
            />
          ))}
        </>
      )}
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
        disabled={disabled || request.state === "awaiting_unlock" || !selection}
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
        disabled={disabled || request.state === "awaiting_unlock" || !selection || !request.origin}
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
