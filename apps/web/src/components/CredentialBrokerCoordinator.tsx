import { useParams } from "@tanstack/react-router";
import {
  credentialDialogAttentionKey,
  reconcileCredentialDialog,
  type CredentialDialogPresentation,
} from "@t3tools/client-runtime/state/credentialBroker";
import { randomUUID } from "../lib/utils";
import { createPortal } from "react-dom";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessReadScope,
  resolveEnvironmentMachineKind,
  type CredentialApproval,
  type CredentialBrokerAction,
  type CredentialNotice,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ProjectFavicon } from "./ProjectFavicon";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject } from "../state/entities";
import { KeyRoundIcon } from "lucide-react";
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
import { RadioGroup, Radio } from "./ui/radio-group";

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
        : (pendingIds.current.values().next().value ?? current),
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
export function EnvironmentBroker({
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
  const route = useParams({ strict: false });
  const viewedThread =
    route.environmentId && route.threadId
      ? { environmentId: route.environmentId, threadId: route.threadId }
      : null;
  const viewKey = JSON.stringify(viewedThread);
  const [presentation, setPresentation] = useState<CredentialDialogPresentation>({
    viewKey,
    attentionKey: null,
    open: false,
  });
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
    state?.requests.filter((r) => ["pending", "awaiting_unlock", "searching"].includes(r.state)) ??
    [];
  const attentionKey = credentialDialogAttentionKey(pending, environmentId, viewedThread);
  const nextPresentation = reconcileCredentialDialog(presentation, viewKey, attentionKey);
  if (nextPresentation !== presentation) setPresentation(nextPresentation);
  const open = nextPresentation.open;
  const setOpen = (open: boolean) => setPresentation({ ...nextPresentation, open });
  const active =
    state?.requests.filter((r) => ["running", "preparing", "saving"].includes(r.state)) ?? [];
  const hasRequests = pending.length + active.length > 0;
  const locked = state?.status === "locked" || state?.status === "unlocking";
  useEffect(() => {
    report(environmentId, open);
    return () => report(environmentId, false);
  }, [environmentId, open, report]);
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
      <Dialog open={focused && open} onOpenChange={setOpen}>
        <DialogPopup showCloseButton>
          <DialogHeader>
            <DialogTitle>
              {locked
                ? "Unlock Bitwarden"
                : hasRequests
                  ? "Credential request"
                  : "Credential access"}
            </DialogTitle>
            {!hasRequests && <p className="text-sm text-muted-foreground">{environmentLabel}</p>}
            <DialogDescription>
              {locked
                ? "Use your Bitwarden master password to unlock your saved credentials."
                : hasRequests
                  ? "Choose a credential and how long to allow access."
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
                <p role="status" className="text-sm text-muted-foreground">
                  Connecting to Credential Broker…
                </p>
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
              {!locked &&
                [...pending, ...active]
                  .toSorted(
                    (a, b) =>
                      Number(b.origin?.threadId === viewedThread?.threadId) -
                      Number(a.origin?.threadId === viewedThread?.threadId),
                  )
                  .map((request) => (
                    <ApprovalCard
                      key={request.requestId}
                      request={request}
                      environmentLabel={environmentLabel}
                      disabled={!canAct}
                      act={act}
                    />
                  ))}
              {state?.status === "ready" && !hasRequests && (
                <p className="text-sm text-muted-foreground">
                  Your vault is ready. New requests ask for permission here.
                </p>
              )}
              {state?.requests
                .filter((request) =>
                  ["expired", "failed", "denied", "completed", "released", "revoked"].includes(
                    request.state,
                  ),
                )
                .slice(0, 3)
                .map((request) => (
                  <p
                    key={request.requestId}
                    role="status"
                    className="text-sm text-muted-foreground"
                  >
                    {request.site} ·{" "}
                    {request.state === "expired"
                      ? "Request expired. No further access is allowed. Ask the agent for a new request to continue."
                      : request.state === "failed"
                        ? (request.error ??
                          "Request failed. Review the request before trying again.")
                        : request.state === "completed"
                          ? "Program finished. Check its result before continuing."
                          : `Request ${request.state}.`}
                  </p>
                ))}
              <details open={!hasRequests && !locked} className="space-y-3 border-t pt-3">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Manage access
                  {state?.grants.length ? ` · ${state.grants.length} saved permissions` : ""}
                </summary>
                {!!state?.grants.length && <h3 className="text-sm font-medium">Always allowed</h3>}
                {state?.grants.map((grant) => (
                  <div key={grant.grantId} className="space-y-2 rounded-xl border p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span>
                        {grant.site} · {grant.field === "sshKey" ? "SSH private key" : grant.field}{" "}
                        · {grant.maxTtl}s maximum
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
                            invocationName: grant.argv0,
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
      <label className="block space-y-1.5 text-sm">
        <span>Bitwarden master password</span>
        <Input
          ref={input}
          type="password"
          autoComplete="off"
          maxLength={4096}
          aria-label="Bitwarden master password"
          disabled={busy || disabled}
        />
      </label>
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
export function ApprovalCard({
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
  const project = useProject(
    request.origin?.projectId
      ? { environmentId: request.origin.environmentId, projectId: request.origin.projectId }
      : null,
  );
  const environment = useEnvironment(request.origin?.environmentId ?? null);
  const callerLabel = request.origin
    ? [request.origin.projectName, request.origin.threadTitle].filter(Boolean).join(" · ")
    : "Unverified caller";
  const [chosenId, setSelection] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const selection = request.candidates.some((candidate) => candidate.id === chosenId)
    ? chosenId
    : request.searchQuery === undefined && request.candidates.length === 1
      ? request.candidates[0]!.id
      : null;
  const selected = request.candidates.find((candidate) => candidate.id === selection);
  const isSshKey = request.field === "sshKey";
  const processing = ["saving", "preparing", "running"].includes(request.state);
  const canAlways = !!request.origin && (!selected?.hostMismatch || request.canSaveHost === true);
  const unavailable = disabled || submitting || request.state !== "pending";
  const submit = async (choice: "deny" | "once" | "always") => {
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
    <section className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="break-all text-xl font-semibold">{request.site}</h2>
          <span className="shrink-0 text-xs text-muted-foreground">
            {request.ttlSeconds}s per use
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
          {callerLabel ? (
            <>
              <span>{callerLabel}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
            className="size-3.5 shrink-0"
          />
          <span>{environmentLabel}</span>
        </div>
        <p className="text-sm">{request.reason}</p>
      </div>
      {processing ? (
        <div className="space-y-4 rounded-lg bg-muted/40 p-4">
          <div role="status" aria-live="polite" className="space-y-1">
            <p className="text-sm font-medium">
              {request.state === "running"
                ? "Program is running"
                : request.state === "saving"
                  ? "Saving credential to Bitwarden…"
                  : "Preparing approved access…"}
            </p>
            <p className="text-sm text-muted-foreground">
              You can keep working. Stop ends this operation and removes temporary credential
              access.
            </p>
          </div>
          <Button
            variant="destructive-outline"
            disabled={disabled}
            onClick={() => void act({ type: "stop", requestId: request.requestId })}
          >
            Stop operation
          </Button>
        </div>
      ) : request.state === "awaiting_unlock" ? (
        <p className="text-sm text-muted-foreground">
          Unlock Bitwarden to choose a credential for this request.
        </p>
      ) : (
        <>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">
                {adding ? "New login" : isSshKey ? "SSH key" : "Saved credential"}
              </h3>
              {request.canSave && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || submitting || request.state !== "pending"}
                  onClick={() => setAdding(!adding)}
                >
                  {adding ? "Choose saved credential" : "Add credential"}
                </Button>
              )}
            </div>
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
                      setSelection(null);
                      void act({
                        type: "search",
                        requestId: request.requestId,
                        ...(query !== undefined ? { query } : {}),
                      });
                    }}
                  />
                )}
                {request.state === "searching" ? (
                  <p
                    role="status"
                    aria-live="polite"
                    className="py-4 text-sm text-muted-foreground"
                  >
                    {request.searchPhase === "syncing"
                      ? "Syncing Bitwarden…"
                      : "Finding credentials…"}
                  </p>
                ) : request.candidates.length > 0 ? (
                  <div className="max-h-56 overflow-y-auto rounded-lg border">
                    <RadioGroup
                      value={selection ?? ""}
                      onValueChange={(value) =>
                        setSelection(typeof value === "string" ? value : null)
                      }
                      aria-label={isSshKey ? "SSH key to share" : "Credential to share"}
                    >
                      {request.candidates.map((candidate) => (
                        <label
                          key={candidate.id}
                          className="flex cursor-pointer items-center gap-3 px-3 py-3 has-[[data-checked]]:bg-muted/50"
                        >
                          <Radio
                            value={candidate.id}
                            disabled={disabled || submitting}
                            aria-label={[
                              candidate.name,
                              candidate.username,
                              candidate.hosts.join(", ") || "No saved host",
                              candidate.hostMismatch ? "Host does not match" : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          />
                          <span className="min-w-0 space-y-0.5">
                            <span className="block break-words text-sm font-medium">
                              {candidate.name}
                            </span>
                            <span className="block break-all text-xs text-muted-foreground">
                              {[candidate.username, candidate.hosts.join(", ") || "No saved host"]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  </div>
                ) : (
                  !request.error && (
                    <p role="status" className="py-3 text-sm text-muted-foreground">
                      No credentials found. Search all Bitwarden or add a login.
                    </p>
                  )
                )}
              </>
            )}
            {request.error && (
              <p role="alert" className="text-sm text-destructive">
                {request.error}
              </p>
            )}
          </div>
          {!adding && (
            <>
              <p className="text-xs text-muted-foreground">
                {selected?.hostMismatch
                  ? `Always allow also saves ${request.site} to this credential in Bitwarden. Existing hosts are kept.`
                  : "Always allow remembers access for this thread, credential, and command. Revoke anytime in Manage access."}
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
                <Button
                  variant="ghost"
                  disabled={disabled || submitting}
                  onClick={() => void submit("deny")}
                >
                  Deny
                </Button>
                <Button
                  variant="outline"
                  disabled={unavailable || !selection || !canAlways}
                  onClick={() => void submit("always")}
                >
                  Always allow
                </Button>
                <Button disabled={unavailable || !selection} onClick={() => void submit("once")}>
                  {submitting ? "Allowing…" : "Allow once"}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          Request details · {request.argv[0]?.split(/[\\/]/).at(-1)}
        </summary>
        <div className="mt-3 space-y-3">
          <p>
            {request.origin
              ? `Requested by ${request.origin.agent} · ${request.origin.providerInstanceId}`
              : "Caller identity is not verified."}
          </p>
          <pre className="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-3">
            {JSON.stringify(
              {
                executable: request.argv[0],
                arguments: request.argv.slice(1),
                directory: request.cwd,
                workspace: request.origin?.workspace,
                fields: request.field,
                lifetimeSeconds: request.ttlSeconds,
              },
              null,
              2,
            )}
          </pre>
          <p>
            Credentials go directly to this program. Stopping removes temporary access; it cannot
            undo actions already completed or erase copied credentials.
          </p>
        </div>
      </details>
    </section>
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
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) search(query);
        }}
      >
        <label className="min-w-0 flex-1 space-y-1 text-sm">
          <span>Search Bitwarden</span>
          <Input
            type="search"
            aria-label="Search Bitwarden by name, username, or host"
            value={query}
            maxLength={200}
            disabled={disabled}
            placeholder="Name, username, or host"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Button type="submit" variant="outline" disabled={disabled}>
          Search
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Search all saved credentials, even when the host differs. Leave blank to browse.
      </p>
      {request.searchQuery !== undefined && (
        <Button variant="ghost" disabled={disabled} onClick={() => search()}>
          Use hostname matches
        </Button>
      )}
    </div>
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
        {notice.revoked ? "Permission revoked" : "Saved credential used automatically"}
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

function SaveLogin({
  request,
  disabled,
  act,
}: {
  request: CredentialApproval;
  disabled: boolean;
  act: (input: CredentialBrokerAction) => Promise<void>;
}) {
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Create a new Bitwarden login for {request.site} and share it once with this program. Enter
        the site password here, not your vault master password. Values stay out of chat.
      </p>
      <form
        autoComplete="off"
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || busy) return;
          const login = {
            username: username.current?.value ?? "",
            password: password.current?.value ?? "",
          };
          if (username.current) username.current.value = "";
          if (password.current) password.current.value = "";
          setBusy(true);
          void act({ type: "saveLogin", requestId: request.requestId, ...login }).finally(() =>
            setBusy(false),
          );
        }}
      >
        <label className="space-y-1">
          <span>Username or email</span>
          <Input
            ref={username}
            aria-label="New login username"
            placeholder="Username or email"
            autoComplete="off"
            maxLength={4096}
            required={request.field !== "password"}
            disabled={disabled || busy}
          />
        </label>
        <label className="space-y-1">
          <span>Site password</span>
          <Input
            ref={password}
            aria-label="New login password"
            placeholder="Site password"
            type="password"
            autoComplete="new-password"
            maxLength={4096}
            required={request.field !== "username"}
            disabled={disabled || busy}
          />
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={disabled || busy}>
            {busy ? "Saving…" : "Save to Bitwarden & allow once"}
          </Button>
        </div>
      </form>
    </div>
  );
}
