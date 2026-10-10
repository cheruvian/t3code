import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";

interface WorktreeGroup {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectTitle: string;
  environmentLabel: string;
  path: string;
  threads: EnvironmentThreadShell[];
}

function WorktreeRow({ group, removed }: { group: WorktreeGroup; removed: boolean }) {
  const navigate = useNavigate();
  const rowRef = useRef<HTMLLIElement>(null);
  const [nearViewport, setNearViewport] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { root: row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]'), rootMargin: "300px" },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const status = useEnvironmentQuery(
    removed || !nearViewport
      ? null
      : vcsEnvironment.status({
          environmentId: group.environmentId,
          input: { cwd: group.path },
        }),
  );
  const primary = group.threads[0]!;
  const files = status.data?.workingTree.files ?? [];
  const dirty = status.data?.hasWorkingTreeChanges === true;

  return (
    <li ref={rowRef} className="rounded-lg border border-border/70 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{formatWorktreePathForDisplay(group.path)}</div>
          <div className="text-xs text-muted-foreground">
            {group.projectTitle} · {group.environmentLabel}
          </div>
          <div className="break-all text-xs text-muted-foreground">{group.path}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {removed
              ? "Worktree removed · conversations kept"
              : dirty
                ? `${files.length} changed ${files.length === 1 ? "file" : "files"} · kept${group.threads.length > 1 ? ` · shared by ${group.threads.length} conversations` : ""}`
                : group.threads.length > 1
                  ? `Shared by ${group.threads.length} conversations · kept`
                  : !nearViewport || status.isPending
                    ? "Checking local changes…"
                    : status.error
                      ? "Could not read local changes · kept"
                      : !status.data?.isRepo
                        ? "Checkout unavailable"
                        : primary.settledAt !== null
                          ? "Settled · remote status checked when removing"
                          : "Active conversation · kept"}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {group.threads.map((thread) => (
            <Button
              key={thread.id}
              size="sm"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: thread.environmentId, threadId: thread.id },
                })
              }
            >
              {group.threads.length === 1 ? "Open conversation" : thread.title}
            </Button>
          ))}
        </div>
      </div>
      {dirty && files.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Review changed files</summary>
          <ul className="mt-2 max-h-48 space-y-1 overflow-auto pl-4 font-mono">
            {files.map((file) => (
              <li key={file.path} className="break-all">
                {file.path}
                {(file.insertions > 0 || file.deletions > 0) && (
                  <span className="ml-2 text-muted-foreground">
                    +{file.insertions} −{file.deletions}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function WorktreeCleanupPanel() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const projects = useProjects();
  const threads = useThreadShells();
  const environmentIds = useMemo(
    () => connectedEnvironments.map((entry) => entry.environmentId),
    [connectedEnvironments],
  );
  const archived = useArchivedThreadSnapshots(environmentIds);
  const removeWorktrees = useAtomCommand(vcsEnvironment.removeSettledWorktrees, {
    reportFailure: false,
  });
  const [running, setRunning] = useState<"default" | "pushed" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [removedPaths, setRemovedPaths] = useState<ReadonlySet<string>>(new Set());
  const projectScoped = scope.kind === "project" || scope.kind === "checkout";
  const groups = useMemo(() => {
    const allowedEnvironments = new Set(connectedEnvironments.map((entry) => entry.environmentId));
    const selectedProjects = projectScoped
      ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
      : null;
    const projectsByKey = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
    );
    const environmentLabels = new Map(
      connectedEnvironments.map((entry) => [entry.environmentId, entry.label]),
    );
    const byPath = new Map<string, WorktreeGroup>();
    const allThreads: EnvironmentThreadShell[] = [
      ...threads,
      ...archived.snapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.threads.map((thread) => presentThreadShell(environmentId, thread)),
      ),
    ];
    for (const thread of allThreads) {
      if (!thread.worktreePath || !allowedEnvironments.has(thread.environmentId)) continue;
      const projectKey = `${thread.environmentId}:${thread.projectId}`;
      if (selectedProjects !== null && !selectedProjects.has(projectKey)) continue;
      const project = projectsByKey.get(projectKey);
      if (!project) continue;
      const key = `${thread.environmentId}:${thread.worktreePath}`;
      const existing = byPath.get(key);
      if (existing) {
        if (!existing.threads.some((entry) => entry.id === thread.id))
          existing.threads.push(thread);
      } else
        byPath.set(key, {
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          projectTitle: project.title,
          environmentLabel: environmentLabels.get(thread.environmentId) ?? "Environment",
          path: thread.worktreePath,
          threads: [thread],
        });
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [projects, threads, archived.snapshots, scope, connectedEnvironments, projectScoped]);

  const removeAll = async (criterion: "default" | "pushed") => {
    setRunning(criterion);
    setMessage(null);
    let removed = 0;
    let failures = 0;
    const scopes = new Map<string, { environmentId: EnvironmentId; projectId?: ProjectId }>();
    for (const group of groups) {
      const key = !projectScoped
        ? group.environmentId
        : `${group.environmentId}:${group.projectId}`;
      scopes.set(key, {
        environmentId: group.environmentId,
        ...(!projectScoped ? {} : { projectId: group.projectId }),
      });
    }
    for (const target of scopes.values()) {
      const result = await removeWorktrees({
        environmentId: target.environmentId,
        input: {
          criterion,
          ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
        },
      });
      if (result._tag === "Success") {
        removed += result.value.removedPaths.length;
        setRemovedPaths(
          (current) =>
            new Set([
              ...current,
              ...result.value.removedPaths.map((path) => `${target.environmentId}:${path}`),
            ]),
        );
      } else failures++;
    }
    setMessage(
      failures > 0
        ? `Removed ${removed} worktrees. ${failures} ${failures === 1 ? "environment" : "environments"} could not be checked.`
        : `Removed ${removed} settled worktrees pushed to ${criterion === "default" ? "the default branch" : "a remote branch"}.`,
    );
    setRunning(null);
  };

  return (
    <SettingsSection id="storage-worktree-review" title="Review worktrees">
      <div className="space-y-3 py-3">
        <p className="text-sm text-muted-foreground">
          Pushed to the default branch means every commit is on that branch. Pushed to a remote
          branch means every commit is on the branch’s upstream, or its same-name branch on the
          primary remote; it may still be unmerged. Local changes, ignored files, and live sessions
          keep a worktree in place. Conversations and branches remain available.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              running !== null ||
              groups.length === 0 ||
              archived.isLoading ||
              archived.error !== null
            }
            onClick={() => void removeAll("default")}
          >
            {running === "default"
              ? "Checking default branch…"
              : "Remove all settled worktrees pushed to default branch"}
          </Button>
          <Button
            variant="outline"
            disabled={
              running !== null ||
              groups.length === 0 ||
              archived.isLoading ||
              archived.error !== null
            }
            onClick={() => void removeAll("pushed")}
          >
            {running === "pushed"
              ? "Checking pushed worktrees…"
              : "Remove all settled worktrees pushed to any remote branch"}
          </Button>
        </div>
        {archived.isLoading && (
          <p className="text-sm text-muted-foreground">Loading archived conversations…</p>
        )}
        {archived.error && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <span>{archived.error} Cleanup is unavailable until they load.</span>
            <Button size="sm" variant="outline" onClick={archived.refresh}>
              Retry
            </Button>
          </div>
        )}
        {message && (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No linked worktrees in this scope.</p>
        ) : (
          <ul className="space-y-2">
            {groups.map((group) => (
              <WorktreeRow
                key={`${group.environmentId}:${group.path}`}
                group={group}
                removed={removedPaths.has(`${group.environmentId}:${group.path}`)}
              />
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
