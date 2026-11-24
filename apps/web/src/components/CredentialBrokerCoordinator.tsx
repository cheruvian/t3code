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
  type CredentialBrokerState,
  type CredentialNotice,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ProjectFavicon } from "./ProjectFavicon";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject } from "../state/entities";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useGT } from "gt-react";
import { useStableCallback } from "../hooks/useStableCallback";
import { credentialBroker } from "../state/credentialBroker";
import { useEnvironments, useEnvironment } from "../state/environments";
import { useEnvironmentsWithScope } from "../state/session";
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
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";

const CredentialAccessContext = createContext<{
  available: boolean;
  pendingCount: number;
  open: () => void;
} | null>(null);

export function useCredentialAccess() {
  return useContext(CredentialAccessContext);
}

type BrokerSummary = { open: boolean; pendingCount: number };
type EnvironmentOption = { environmentId: EnvironmentId; label: string };
type ManualSelection = { environmentId: EnvironmentId };

export function CredentialBrokerCoordinator({ children }: { children?: ReactNode }) {
  const { environments } = useEnvironments();
  const allowed = useEnvironmentsWithScope(environments, AuthAccessReadScope);
  const options = environments.filter((environment) => allowed.has(environment.environmentId));
  const route = useParams({ strict: false });
  const [activeId, setActiveId] = useState<EnvironmentId>();
  const [selection, setSelection] = useState<ManualSelection>();
  const [summaries, setSummaries] = useState(new Map<EnvironmentId, BrokerSummary>());
  const [noticeRoot, setNoticeRoot] = useState<HTMLDivElement | null>(null);
  const report = useStableCallback((id: EnvironmentId, summary: BrokerSummary | null) => {
    if (summary?.open) {
      setActiveId((current) => (current && summaries.get(current)?.open ? current : id));
    }
    setSummaries((current) => {
      const next = new Map(current);
      if (summary) next.set(id, summary);
      else next.delete(id);
      return next;
    });
  });
  const focusedId =
    activeId && allowed.has(activeId) && summaries.get(activeId)?.open
      ? activeId
      : options.find((environment) => summaries.get(environment.environmentId)?.open)
          ?.environmentId;
  const pendingCount = options.reduce(
    (count, environment) => count + (summaries.get(environment.environmentId)?.pendingCount ?? 0),
    0,
  );
  const select = (environmentId: EnvironmentId) => {
    setActiveId(environmentId);
    setSelection({ environmentId });
  };
  const open = () => {
    const target =
      options.find(
        (environment) => (summaries.get(environment.environmentId)?.pendingCount ?? 0) > 0,
      ) ??
      options.find((environment) => environment.environmentId === activeId) ??
      options.find((environment) => environment.environmentId === route.environmentId) ??
      options[0];
    if (target) select(target.environmentId);
  };
  return (
    <CredentialAccessContext value={{ available: options.length > 0, pendingCount, open }}>
      {children}
      {options.map(({ environmentId }) => (
        <EnvironmentBroker
          key={environmentId}
          environmentId={environmentId}
          active={focusedId === environmentId}
          selection={selection}
          select={select}
          options={options}
          summaries={summaries}
          report={report}
          noticeRoot={noticeRoot}
        />
      ))}
      <div
        ref={setNoticeRoot}
        className="fixed right-4 bottom-4 z-[110] flex max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto"
      />
    </CredentialAccessContext>
  );
}
type BrokerProps = {
  environmentId: EnvironmentId;
  active: boolean;
  selection: ManualSelection | undefined;
  select: (id: EnvironmentId) => void;
  options: EnvironmentOption[];
  summaries: Map<EnvironmentId, BrokerSummary>;
  report: (id: EnvironmentId, summary: BrokerSummary | null) => void;
  noticeRoot: HTMLDivElement | null;
};
function EnvironmentBroker({
  environmentId,
  active: focused,
  selection,
  select,
  options,
  summaries,
  report,
  noticeRoot,
}: BrokerProps) {
  const gt = useGT();
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
  const [lastSelection, setLastSelection] = useState(selection);
  const [error, setError] = useState<string>();
  const [selectedTab, setSelectedTab] = useState<string | null>(null);

  const state = AsyncResult.isSuccess(result) ? result.value : undefined;
  const canAct = permission;
  const tab = selectedTab ?? (state?.status === "ready" ? "requests" : "accounts");
  const act = async (input: CredentialBrokerAction) => {
    if (input.type === "unlock") setSelectedTab("accounts");
    const response = await run({ environmentId, input });
    if (response._tag === "Failure")
      setError("Could not complete the action. Check connection, permissions, and vault status.");
    else {
      setError(undefined);
      if (input.type === "revoke") setPresentation((current) => ({ ...current, open: false }));
    }
  };
  // Each new subscription snapshot must restore presenter visibility after reconnect.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish presenter visibility to the credential broker.
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
  }, [state, canAct, environmentId, run, viewId]);
  const pending =
    state?.requests.filter(
      (r) => !r.grantId && ["pending", "awaiting_unlock", "searching"].includes(r.state),
    ) ?? [];
  const attentionKey = pending.length
    ? JSON.stringify(pending.map((request) => request.requestId).sort())
    : null;
  let nextPresentation = reconcileCredentialDialog(
    presentation,
    viewKey,
    attentionKey,
    credentialDialogAttentionKey(pending, environmentId, viewedThread) !== null,
  );
  if (selection !== lastSelection) {
    setLastSelection(selection);
    nextPresentation = { ...nextPresentation, open: selection?.environmentId === environmentId };
  }
  if (nextPresentation !== presentation) setPresentation(nextPresentation);
  const open = nextPresentation.open;
  const setOpen = (open: boolean) => setPresentation({ ...nextPresentation, open });
  const active =
    state?.requests.filter((r) => ["running", "preparing", "saving"].includes(r.state)) ?? [];
  const hasRequests = pending.length + active.length > 0;
  const locked = state?.status === "locked" || state?.status === "unlocking";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Report dialog ownership across environment presenters.
  useEffect(() => {
    report(environmentId, { open, pendingCount: pending.length });
    return () => report(environmentId, null);
  }, [environmentId, open, pending.length, report]);
  return (
    <>
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
              <Select
                value={environmentId}
                onValueChange={(value) => {
                  if (value) select(value);
                }}
                items={options.map((option) => ({
                  value: option.environmentId,
                  label: option.label,
                }))}
              >
                <SelectTrigger aria-label={gt("Credential access environment")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {options.map((option) => {
                    const count = summaries.get(option.environmentId)?.pendingCount ?? 0;
                    return (
                      <SelectItem key={option.environmentId} value={option.environmentId}>
                        {option.label}
                        {count > 0 ? ` · ${gt("{count} pending", { count })}` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
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
              <div role="tablist" aria-label="Credential access" className="flex gap-2">
                {["requests", "accounts", "approvals"].map((value) => (
                  <Button
                    key={value}
                    role="tab"
                    aria-selected={tab === value}
                    id={`credential-tab-${viewId}-${value}`}
                    aria-controls={`credential-panel-${viewId}-${value}`}
                    variant={tab === value ? "secondary" : "ghost"}
                    onClick={() => setSelectedTab(value)}
                  >
                    {value === "requests"
                      ? "Requests"
                      : value === "accounts"
                        ? gt("Vaults")
                        : "Saved approvals"}
                  </Button>
                ))}
              </div>
              <div
                role="tabpanel"
                id={`credential-panel-${viewId}-${tab}`}
                aria-labelledby={`credential-tab-${viewId}-${tab}`}
              >
                {tab === "accounts" && (
                  <div className="space-y-3">
                    {state && state.status !== "unsupported" && (
                      <VaultManager profiles={state.profiles ?? []} disabled={!canAct} act={act} />
                    )}
                    {(state?.accounts ?? []).length > 0 && (
                      <p className="text-sm">Unlocked accounts: {state?.accounts?.join(", ")}</p>
                    )}
                    {state?.status === "ready" && (
                      <Button
                        variant="outline"
                        disabled={!canAct || state.refreshing === true}
                        onClick={() => void act({ type: "refresh" })}
                      >
                        {state.refreshing ? "Refreshing accounts…" : "Refresh accounts"}
                      </Button>
                    )}
                  </div>
                )}
                {tab === "requests" && (
                  <>
                    {[...pending, ...active]
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
                        [
                          "expired",
                          "failed",
                          "denied",
                          "completed",
                          "released",
                          "revoked",
                        ].includes(request.state),
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
                  </>
                )}
                {tab === "approvals" && (
                  <div className="space-y-3">
                    {!state?.grants.length && (
                      <p className="text-sm text-muted-foreground">No saved approvals.</p>
                    )}
                    {!!state?.grants.length && (
                      <h3 className="text-sm font-medium">Always allowed</h3>
                    )}
                    {state?.grants.map((grant) => (
                      <div key={grant.grantId} className="space-y-2 rounded-xl border p-3 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <span>
                            {grant.site} ·{" "}
                            {grant.field === "sshKey" ? "SSH private key" : grant.field} ·{" "}
                            {grant.maxTtl}s maximum
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
                  </div>
                )}
              </div>
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
function VaultManager({
  profiles,
  disabled,
  act,
}: {
  profiles: NonNullable<CredentialBrokerState["profiles"]>;
  disabled: boolean;
  act: (input: CredentialBrokerAction) => Promise<void>;
}) {
  const gt = useGT();
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const entry = profiles.find((profile) => profile.directory === selected);
  const adding = selected === "add";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={disabled} onClick={() => setSelected("add")}>
          {gt("Add vault")}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => void act({ type: "discoverProfiles" })}
        >
          {gt("Find vaults")}
        </Button>
      </div>
      <ul className="space-y-2">
        {profiles.map((profile) => {
          const busy =
            pending.includes(profile.directory) ||
            profile.status === "queued" ||
            profile.status === "unlocking";
          const ready = profile.status === "ready";
          return (
            <li key={profile.directory} className="rounded-xl border p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 break-words text-sm font-medium">{profile.name}</span>
                <div className="flex shrink-0 items-center gap-2">
                  {ready ? (
                    <span className="text-xs text-muted-foreground">{gt("Unlocked")}</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled || busy}
                      onClick={() => setSelected(profile.directory)}
                    >
                      {profile.status === "queued"
                        ? gt("Queued")
                        : busy
                          ? gt("Unlocking…")
                          : gt("Unlock vault")}
                    </Button>
                  )}
                  {profile.saved && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled || busy}
                      onClick={() =>
                        void act({ type: "forgetProfile", directory: profile.directory })
                      }
                    >
                      {gt("Forget")}
                    </Button>
                  )}
                </div>
              </div>
              {profile.error && (
                <p role="alert" className="text-sm text-destructive">
                  {profile.error}
                </p>
              )}
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{gt("Vault settings")}</summary>
                <p className="mt-2 break-all">{profile.directory}</p>
              </details>
            </li>
          );
        })}
      </ul>
      {(adding || entry) && (
        <VaultPasswordForm
          key={selected}
          entry={entry}
          disabled={disabled}
          cancel={() => setSelected(null)}
          submit={(input) => {
            const key = input.profileDirectory ?? "default";
            setSelected(null);
            setPending((current) => [...current, key]);
            void act(input).finally(() =>
              setPending((current) => current.filter((value) => value !== key)),
            );
          }}
        />
      )}
      <p className="text-xs text-muted-foreground">
        {gt(
          "Vaults unlock one at a time. You can enter another vault’s password while an unlock is running.",
        )}
      </p>
    </div>
  );
}
function VaultPasswordForm({
  entry,
  disabled,
  cancel,
  submit,
}: {
  entry: NonNullable<CredentialBrokerState["profiles"]>[number] | undefined;
  disabled: boolean;
  cancel: () => void;
  submit: (input: Extract<CredentialBrokerAction, { type: "unlock" }>) => void;
}) {
  const gt = useGT();
  const password = useRef<HTMLInputElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const directory = useRef<HTMLInputElement>(null);
  const executable = useRef<HTMLInputElement>(null);
  return (
    <form
      className="space-y-3 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const value = password.current?.value ?? "";
        if (password.current) password.current.value = "";
        submit({
          type: "unlock",
          password: value,
          ...(entry
            ? {
                profileDirectory: entry.directory,
                ...(!entry.saved ? { account: entry.name, executable: entry.executable } : {}),
              }
            : {
                account: name.current?.value || "Default",
                profileDirectory: directory.current?.value || undefined,
                executable: executable.current?.value || "bw",
              }),
        });
      }}
    >
      <h3 className="text-sm font-medium">
        {entry ? gt("Unlock {vault}", { vault: entry.name }) : gt("Add vault")}
      </h3>
      {!entry && (
        <>
          <label className="block space-y-1.5 text-sm">
            <span>{gt("Vault name")}</span>
            <Input ref={name} disabled={disabled} required maxLength={320} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>{gt("CLI profile directory (blank for default)")}</span>
            <Input ref={directory} disabled={disabled} />
          </label>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">{gt("Bitwarden CLI location")}</summary>
            <Input
              ref={executable}
              defaultValue="bw"
              aria-label={gt("Bitwarden CLI executable")}
              disabled={disabled}
            />
          </details>
        </>
      )}
      <label className="block space-y-1.5 text-sm">
        <span>{gt("Bitwarden master password")}</span>
        <Input
          ref={password}
          type="password"
          autoComplete="off"
          required
          maxLength={4096}
          disabled={disabled}
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={disabled}>
          {entry ? gt("Unlock vault") : gt("Add and unlock")}
        </Button>
        <Button type="button" variant="ghost" disabled={disabled} onClick={cancel}>
          {gt("Cancel")}
        </Button>
      </div>
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
  const gt = useGT();
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
  const [approvalScope, setApprovalScope] = useState<"thread" | "project" | "t3">("thread");
  const [durationSeconds, setDurationSeconds] = useState<3600 | undefined>();
  const [saveHost, setSaveHost] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [denialMessage, setDenialMessage] = useState("");
  const selection = request.candidates.some((candidate) => candidate.id === chosenId)
    ? chosenId
    : !request.accountFiltersCleared &&
        request.searchQuery === undefined &&
        request.candidates.length === 1 &&
        !request.candidates[0]!.hostMismatch
      ? request.candidates[0]!.id
      : null;
  const selected = request.candidates.find((candidate) => candidate.id === selection);
  const isSshKey = request.field === "sshKey";
  const processing = ["saving", "preparing", "running"].includes(request.state);
  const canAlways = !!request.origin && (!selected?.hostMismatch || request.canSaveHost === true);
  const unavailable = disabled || submitting || request.state !== "pending";
  const submit = async (choice: "deny" | "once" | "always", noPassword = false) => {
    if (disabled || submitting) return;
    setSubmitting(true);
    await (async () => {
      await act({
        type: "decide",
        requestId: request.requestId,
        decision: choice,
        ...(choice === "deny"
          ? { denialMessage, ...(noPassword ? { denialReason: "no_saved_password" as const } : {}) }
          : {}),
        ...(choice === "always" ? { approvalScope } : {}),
        ...(choice === "always" && durationSeconds ? { durationSeconds } : {}),
        ...(choice !== "deny" && saveHost ? { saveHost: true } : {}),
        ...(choice !== "deny" && selection ? { candidateId: selection } : {}),
      });
    })().finally(() => {
      setSubmitting(false);
    });
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
      {(request.accountFilter !== undefined || !!request.excludedAccounts?.length) && (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="font-medium">
            {request.accountFiltersCleared ? gt("Account filters cleared") : gt("Account filters")}
          </p>
          {!request.accountFiltersCleared && (
            <>
              {request.accountFilter !== undefined && (
                <p className="break-all">
                  {gt("Only account: {account}", { account: request.accountFilter })}
                </p>
              )}
              {!!request.excludedAccounts?.length && (
                <p className="break-all">
                  {gt("Excluded accounts: {accounts}", {
                    accounts: request.excludedAccounts.join(", "),
                  })}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {gt(
                  "Filters match exact, case-sensitive usernames or credential IDs, even when searching Bitwarden.",
                )}
              </p>
            </>
          )}
          {request.accountFiltersCleared && (
            <p className="text-xs text-muted-foreground">
              {gt(
                "Choose a saved credential, then approve access. This change applies only to this request.",
              )}
            </p>
          )}
          {request.canSearch && (
            <Button
              variant="outline"
              size="sm"
              disabled={unavailable || !!request.grantId}
              onClick={() => {
                setSelection(null);
                setSaveHost(false);
                void act({
                  type: "setAccountFilters",
                  requestId: request.requestId,
                  enabled: request.accountFiltersCleared === true,
                });
              }}
            >
              {request.accountFiltersCleared
                ? gt("Restore account filters")
                : gt("Clear account filters")}
            </Button>
          )}
        </div>
      )}
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
                {adding
                  ? "New login"
                  : request.field === "ssh"
                    ? "SSH key or login"
                    : isSshKey
                      ? "SSH key"
                      : "Saved credential"}
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
                              candidate.kind === "sshKey"
                                ? "SSH key"
                                : candidate.kind === "login"
                                  ? "Login"
                                  : "",
                              candidate.username,
                              candidate.hosts.join(", ") || "No saved host",
                              candidate.matchReason === "shortHost"
                                ? "Short hostname suggestion"
                                : candidate.matchReason === "wildcard"
                                  ? "Wildcard host suggestion"
                                  : candidate.hostMismatch
                                    ? "Host does not match"
                                    : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          />
                          <span className="min-w-0 space-y-0.5">
                            <span className="block break-words text-sm font-medium">
                              {candidate.name}
                              {candidate.kind && (
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {candidate.kind === "sshKey" ? "SSH key" : "Login"}
                                </span>
                              )}
                            </span>
                            <span className="block break-all text-xs text-muted-foreground">
                              {[candidate.username, candidate.hosts.join(", ") || "No saved host"]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                            {candidate.hostMismatch && (
                              <span className="block text-xs text-muted-foreground">
                                {candidate.matchReason === "shortHost"
                                  ? "Short hostname suggestion"
                                  : candidate.matchReason === "wildcard"
                                    ? "Wildcard host suggestion"
                                    : "Host does not match"}{" "}
                                · confirm before allowing
                              </span>
                            )}
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
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={unavailable}
                  onClick={() => setDurationSeconds(durationSeconds ? undefined : 3600)}
                >
                  {durationSeconds ? "Duration: 1 hour" : "Duration: unlimited"}
                </Button>
                <Button
                  variant="outline"
                  disabled={unavailable || !request.origin}
                  onClick={() =>
                    setApprovalScope(
                      approvalScope === "thread"
                        ? "project"
                        : approvalScope === "project"
                          ? "t3"
                          : "thread",
                    )
                  }
                >
                  Scope: {approvalScope === "t3" ? "T3" : approvalScope}
                </Button>
                {selected?.hostMismatch && request.canSaveHost && (
                  <Button
                    variant="outline"
                    disabled={unavailable}
                    onClick={() => setSaveHost(!saveHost)}
                  >
                    {saveHost ? "✓ Save domain to credential" : "Save domain to credential"}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {selected?.hostMismatch
                  ? `Always allow also saves ${request.site} to this credential in Bitwarden. Existing hosts are kept.`
                  : "Remembered access applies to this credential and command. Revoke anytime in Saved approvals."}
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  disabled={unavailable || !selection || !canAlways}
                  onClick={() => void submit("always")}
                >
                  {durationSeconds
                    ? "Allow for 1 hour"
                    : `Allow for ${approvalScope === "t3" ? "T3" : `this ${approvalScope}`}`}
                </Button>
                <Button disabled={unavailable || !selection} onClick={() => void submit("once")}>
                  {submitting ? "Allowing…" : "Allow once"}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {["pending", "searching", "awaiting_unlock"].includes(request.state) && (
        <div className="space-y-3 border-t pt-3">
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">{gt("Add a denial reason (optional)")}</summary>
            <Input
              className="mt-2"
              value={denialMessage}
              onChange={(event) => setDenialMessage(event.target.value)}
              maxLength={500}
              disabled={disabled || submitting}
              aria-label={gt("Denial reason")}
              placeholder={gt("Sent to the agent. Do not include passwords.")}
            />
          </details>
          <div className="flex flex-wrap gap-2">
            {!["ssh", "sshKey"].includes(request.field) && (
              <Button
                variant="outline"
                disabled={disabled || submitting}
                onClick={() => void submit("deny", true)}
              >
                {gt("No password exists")}
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={disabled || submitting}
              onClick={() => void submit("deny")}
            >
              {gt("Deny")}
            </Button>
          </div>
        </div>
      )}
      <section className="text-xs text-muted-foreground">
        <h3 className="font-medium">Request details · {request.argv[0]?.split(/[\\/]/).at(-1)}</h3>
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
                search: request.searchDiagnostics,
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
      </section>
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
            aria-label="Search Bitwarden by name, username, or URL"
            value={query}
            maxLength={200}
            disabled={disabled}
            placeholder="Name, username, or URL"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Button type="submit" variant="outline" disabled={disabled}>
          Search
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Search names, usernames, and domains/URLs. Leave blank to browse.
      </p>
      {request.searchQuery !== undefined && (
        <Button variant="ghost" disabled={disabled} onClick={() => search()}>
          Use suggested credentials
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Acknowledge notices only after they become visible.
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
  const account = useRef<HTMLInputElement>(null);
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Create a new Bitwarden login for {request.site} and share it once with this program. Enter
        the site password here, not your vault master password. Values stay out of chat.
      </p>
      {request.field === "username" && (
        <Button
          variant="outline"
          disabled={disabled || busy}
          aria-pressed={google}
          onClick={() => {
            setGoogle(!google);
            if (password.current) password.current.value = "";
          }}
        >
          {google ? "Use a regular login" : "Sign in with Google"}
        </Button>
      )}
      {google && <p>Save the Google email you use for this site. No Google password is needed.</p>}
      <form
        autoComplete="off"
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || busy) return;
          const login = {
            account: account.current?.value || undefined,
            username: username.current?.value ?? "",
            password: google ? "" : (password.current?.value ?? ""),
            ...(google ? { authProvider: "google" as const } : {}),
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
          <span>Destination account (required with multiple accounts)</span>
          <Input
            ref={account}
            aria-label="Destination Bitwarden account"
            maxLength={320}
            disabled={disabled || busy}
          />
        </label>
        <label className="space-y-1">
          <span>Username or email</span>
          <Input
            ref={username}
            aria-label="New login username"
            placeholder="Username or email"
            autoComplete="off"
            maxLength={google ? 320 : 4096}
            required={request.field !== "password"}
            disabled={disabled || busy}
          />
        </label>
        {!google && (
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
        )}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={disabled || busy}>
            {busy ? "Saving…" : "Save to Bitwarden & allow once"}
          </Button>
        </div>
      </form>
    </div>
  );
}
