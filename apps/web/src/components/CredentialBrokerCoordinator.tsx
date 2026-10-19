import { randomUUID } from "../lib/utils";
import { createPortal } from "react-dom";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessReadScope,
  type CredentialApproval,
  type CredentialBrokerAction,
  type CredentialNotice,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { credentialBroker } from "../state/credentialBroker";
import { useEnvironmentIds, useEnvironment } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";

export function CredentialBrokerCoordinator() {
  const environmentIds = useEnvironmentIds();
  const [activeId, setActiveId] = useState<EnvironmentId>();
  const [noticeRoot, setNoticeRoot] = useState<HTMLDivElement | null>(null);
  const pendingIds = useRef(new Set<EnvironmentId>());
  const report = useCallback((id: EnvironmentId, pending: boolean) => {
    if (pending) pendingIds.current.add(id);
    else pendingIds.current.delete(id);
    setActiveId((current) =>
      current && pendingIds.current.has(current)
        ? current
        : pendingIds.current.values().next().value,
    );
  }, []);
  return (
    <>
      <div className="fixed right-4 bottom-4 z-40 flex flex-col items-end gap-2">
        {environmentIds.map((environmentId) => (
          <AuthorizedBroker
            key={environmentId}
            environmentId={environmentId}
            active={activeId === environmentId}
            select={() => setActiveId(environmentId)}
            report={report}
            noticeRoot={noticeRoot}
          />
        ))}
      </div>
      <div
        ref={setNoticeRoot}
        className="fixed right-4 bottom-16 z-[110] flex max-h-[calc(100dvh-5rem)] w-[min(26rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto"
      />
    </>
  );
}
type BrokerProps = {
  environmentId: EnvironmentId;
  active: boolean;
  select: () => void;
  report: (id: EnvironmentId, pending: boolean) => void;
  noticeRoot: HTMLDivElement | null;
};
function AuthorizedBroker(props: BrokerProps) {
  return useEnvironmentScope(props.environmentId, AuthAccessReadScope) ? (
    <EnvironmentBroker {...props} />
  ) : null;
}
function EnvironmentBroker({
  environmentId,
  active: focused,
  select,
  report,
  noticeRoot,
}: BrokerProps) {
  const environment = useEnvironment(environmentId);
  const environmentLabel = environment?.label ?? environmentId;
  const [viewId] = useState(randomUUID);
  const result = useAtomValue(credentialBroker.state({ environmentId, input: { viewId } }));
  const run = useAtomCommand(credentialBroker.action, {
    reportFailure: false,
    reportDefect: false,
  });
  const permission = useAtomValue(credentialBroker.action.permissionAtom(environmentId));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const state = AsyncResult.isSuccess(result) ? result.value : undefined;
  const canAct = permission;
  const act = async (input: CredentialBrokerAction) => {
    const response = await run({ environmentId, input });
    if (response._tag === "Failure")
      setError("Could not complete the action. Check connection, permissions, and vault status.");
    else setError(undefined);
  };
  useEffect(() => {
    if (!state?.status || !canAct) return;
    const visible = () => {
      void run({
        environmentId,
        input: { type: "presenter", viewId, visible: document.visibilityState === "visible" },
      });
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => {
      document.removeEventListener("visibilitychange", visible);
    };
  }, [state?.status, canAct, environmentId, run, viewId]);
  const pending =
    state?.requests.filter((r) => ["pending", "awaiting_unlock"].includes(r.state)) ?? [];
  const active = state?.requests.filter((r) => ["running", "preparing"].includes(r.state)) ?? [];
  useEffect(() => {
    report(environmentId, pending.length > 0);
    return () => report(environmentId, false);
  }, [environmentId, pending.length, report]);
  return (
    <>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            select();
            setOpen(true);
          }}
        >
          <KeyRoundIcon /> Credential access · {environmentLabel} {pending.length || ""}
        </Button>
      </div>
      <Dialog open={focused && (open || pending.length > 0)} onOpenChange={setOpen}>
        <DialogPopup
          size={pending.length ? "wide" : "default"}
          showCloseButton={pending.length === 0}
        >
          <DialogHeader>
            <DialogTitle>{pending.length ? "Credential request" : "Credential access"}</DialogTitle>
            {pending.length === 0 && (
              <p className="text-sm text-muted-foreground">{environmentLabel}</p>
            )}
            <DialogDescription>
              {pending.length
                ? "Review who is asking and choose what to share."
                : "Manage your vault and saved permissions."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {state?.error && (
                <p role="alert" className="text-sm text-destructive">
                  {state.error}
                </p>
              )}
              {!state && (
                <p className="text-sm text-muted-foreground">Connecting to Credential Broker…</p>
              )}
              {state?.status === "unsupported" && (
                <p className="text-sm">
                  Windows needs ACL, named-pipe, and process-tree security adapters. Credential
                  access is unavailable.
                </p>
              )}
              {(state?.status === "locked" || state?.status === "unlocking") && (
                <VaultUnlock
                  busy={state.status === "unlocking"}
                  disabled={!canAct}
                  unlock={(password, executable) => act({ type: "unlock", password, executable })}
                />
              )}
              {pending.map((request) => (
                <ApprovalCard
                  key={request.requestId}
                  request={request}
                  environmentLabel={environmentLabel}
                  disabled={!canAct}
                  act={act}
                />
              ))}
              {state?.status === "ready" && pending.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Your vault is ready. New requests ask for permission here.
                </p>
              )}
              {active.map((request) => (
                <div
                  key={request.requestId}
                  className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm"
                >
                  <span>
                    {request.site} · {request.state}
                  </span>
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    disabled={!canAct}
                    onClick={() => void act({ type: "stop", requestId: request.requestId })}
                  >
                    Stop
                  </Button>
                </div>
              ))}
              <details open={pending.length === 0} className="space-y-3 border-t pt-3">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Manage access
                  {state?.grants.length ? ` · ${state.grants.length} saved permissions` : ""}
                </summary>
                {!!state?.grants.length && <h3 className="text-sm font-medium">Always allowed</h3>}
                {state?.grants.map((grant) => (
                  <div key={grant.grantId} className="space-y-2 rounded-xl border p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span>
                        {grant.site} · {grant.field} · {grant.maxTtl}s maximum
                      </span>
                      <Button
                        variant="destructive-outline"
                        size="sm"
                        disabled={!canAct}
                        onClick={() => void act({ type: "revoke", grantId: grant.grantId })}
                      >
                        Revoke &amp; stop
                      </Button>
                    </div>
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">
                        Permission scope
                      </summary>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-xs">
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
                      </pre>
                    </details>
                  </div>
                ))}
                {state?.status === "ready" && (
                  <Button
                    variant="outline"
                    disabled={!canAct}
                    onClick={() => void act({ type: "lock" })}
                  >
                    Lock vault &amp; stop access
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  Revocation stops supervised programs and deletes active credential files. It
                  cannot erase copied secrets or end an established website session.
                </p>
              </details>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      {noticeRoot &&
        createPortal(
          <>
            {state?.notices.map((notice) => (
              <AutomaticNotice
                key={notice.noticeId}
                notice={notice}
                environmentLabel={environmentLabel}
                disabled={!canAct}
                act={act}
                seen={() =>
                  void run({
                    environmentId,
                    input: { type: "seen", viewId, noticeId: notice.noticeId },
                  })
                }
              />
            ))}
          </>,
          noticeRoot,
        )}
    </>
  );
}
function VaultUnlock({
  busy,
  disabled,
  unlock,
}: {
  busy: boolean;
  disabled: boolean;
  unlock: (password: string, executable: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const executable = useRef<HTMLInputElement>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const password = input.current?.value ?? "";
        if (input.current) input.current.value = "";
        void unlock(password, executable.current?.value || "bw");
      }}
      className="space-y-3"
    >
      <p className="text-sm">
        Unlock Bitwarden privately. The server must already be signed in with the Bitwarden CLI.
      </p>
      <Input
        ref={input}
        type="password"
        autoComplete="off"
        maxLength={4096}
        aria-label="Bitwarden master password"
        disabled={busy || disabled}
      />
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">Bitwarden CLI location</summary>
        <div className="mt-2">
          <Input
            ref={executable}
            defaultValue="bw"
            aria-label="Bitwarden CLI executable"
            disabled={busy || disabled}
          />
        </div>
      </details>
      <Button type="submit" disabled={busy || disabled}>
        {busy ? "Unlocking…" : "Unlock vault"}
      </Button>
    </form>
  );
}
function ApprovalCard({
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
  const [selection, setSelection] = useState<string | null>(
    request.candidates.length === 1 ? request.candidates[0]!.id : null,
  );
  const waitingForUnlock = request.state === "awaiting_unlock";
  const fields =
    request.field === "login"
      ? "Username + password"
      : request.field === "password"
        ? "Password"
        : "Username";
  return (
    <section className="space-y-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div>
          <p className="text-xs text-muted-foreground">{fields} requested for</p>
          <h2 className="break-all text-lg font-semibold">{request.site}</h2>
        </div>
        <p className="text-xs text-muted-foreground">{request.ttlSeconds}s access after approval</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2 rounded-lg bg-muted/40 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <ShieldCheckIcon className="size-3.5" />
            {request.origin ? "Caller verified by T3" : "Unverified caller"}
          </div>
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Project</dt>
            <dd className="break-words font-medium">
              {request.origin?.projectName || "Not available"}
            </dd>
            <dt className="text-muted-foreground">Thread</dt>
            <dd className="break-words font-medium">
              {request.origin?.threadTitle || "No verified T3 thread"}
            </dd>
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="break-words">
              {request.origin
                ? `${request.origin.agent} · ${request.origin.providerInstanceId}`
                : "Not verified"}
            </dd>
            <dt className="text-muted-foreground">Environment</dt>
            <dd className="break-words font-medium">{environmentLabel}</dd>
            <dt className="text-muted-foreground">Program</dt>
            <dd className="break-all font-mono text-xs">
              {request.argv[0]?.split(/[\\/]/).at(-1)}
            </dd>
          </dl>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Reason supplied by agent</p>
            <p className="line-clamp-2 break-words text-sm">{request.reason}</p>
          </div>
          {waitingForUnlock ? (
            <p className="text-sm text-muted-foreground">
              Unlock the vault to choose a login. Access still needs your approval.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Share this saved login</p>
              <Select
                value={selection}
                onValueChange={setSelection}
                items={request.candidates.map((c) => ({
                  value: c.id,
                  label: c.name + " · " + c.hosts.join(", "),
                }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a login" />
                </SelectTrigger>
                <SelectPopup>
                  {request.candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} · {c.hosts.join(", ")}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}
          <details className="space-y-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Command, workspace & permission scope
            </summary>
            <pre className="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-3">
              {JSON.stringify(
                {
                  executable: request.argv[0],
                  arguments: request.argv.slice(1),
                  directory: request.cwd,
                  workspace: request.origin?.workspace,
                  environment: request.origin?.environmentId,
                  project: request.origin?.projectId,
                  thread: request.origin?.threadId,
                  provider: request.origin?.providerInstanceId,
                  session: request.origin?.providerSessionId,
                  toolCall: request.origin?.toolCallId,
                  run: request.origin?.runId,
                  requestedLabel: request.label,
                  reason: request.reason,
                  callerClaim: request.clientClaim,
                },
                null,
                2,
              )}
            </pre>
            <p className="text-muted-foreground">
              Always allow saves permission for this thread, provider, workspace, login, fields,
              exact command, executable and script fingerprints, and maximum lifetime. Review or
              revoke it under Manage access.
            </p>
            <p className="text-muted-foreground">
              Credentials go directly to this program. Revocation stops supervised programs and
              deletes active credential files; it cannot erase copied secrets or end website
              sessions.
            </p>
          </details>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          {request.approvalDeadline === null
            ? "No approval timeout"
            : `Approval expires ${new Date(request.approvalDeadline).toLocaleTimeString()}`}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              void act({ type: "decide", requestId: request.requestId, decision: "deny" })
            }
          >
            Deny
          </Button>
          {!waitingForUnlock && (
            <>
              <Button
                variant="outline"
                disabled={disabled || !selection || !request.origin}
                onClick={() =>
                  void act({
                    type: "decide",
                    requestId: request.requestId,
                    decision: "always",
                    candidateId: selection!,
                  })
                }
              >
                Always allow
              </Button>
              <Button
                disabled={disabled || !selection}
                onClick={() =>
                  void act({
                    type: "decide",
                    requestId: request.requestId,
                    decision: "once",
                    candidateId: selection!,
                  })
                }
              >
                Allow once
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function AutomaticNotice({
  notice,
  environmentLabel,
  disabled,
  act,
  seen,
}: {
  notice: CredentialNotice;
  environmentLabel: string;
  disabled: boolean;
  act: (input: CredentialBrokerAction) => Promise<void>;
  seen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const acknowledged = useRef(false);
  useEffect(() => {
    if (!ref.current || disabled || acknowledged.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.intersectionRatio === 1 && document.visibilityState === "visible") {
          acknowledged.current = true;
          requestAnimationFrame(() => requestAnimationFrame(seen));
          observer.disconnect();
        }
      },
      { threshold: 1 },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [disabled, seen]);
  return (
    <div
      ref={ref}
      role="status"
      className="space-y-2 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <p className="text-sm font-medium">
        {notice.revoked ? "Permission revoked" : "Saved login used automatically"}
      </p>
      <p className="text-sm text-muted-foreground">
        {environmentLabel} · {notice.site} · {notice.command}
      </p>
      <p className="text-xs text-muted-foreground">
        Notice available until {new Date(notice.expiresAt).toLocaleTimeString()}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => void act({ type: "dismiss", noticeId: notice.noticeId })}
        >
          Dismiss
        </Button>
        <Button
          variant="destructive-outline"
          size="sm"
          disabled={disabled || notice.revoked}
          onClick={() => void act({ type: "revoke", grantId: notice.grantId })}
        >
          Revoke &amp; stop
        </Button>
      </div>
    </div>
  );
}
