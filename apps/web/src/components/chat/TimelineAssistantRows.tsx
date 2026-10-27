import { MessageSpeechButton } from "./MessageSpeechButton";
import { MessageSpeechRateControl } from "./MessageSpeechRateControl";
import { MessageSpeechSections } from "./MessageSpeechSections";
import { getMessageSpeechPlayer, messageSpeechSections } from "~/lib/messageSpeech";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { type RunId } from "@t3tools/contracts";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import { memo, use, useState, useMemo, useCallback } from "react";
import { type ChatMessage, type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { GitForkIcon } from "lucide-react";
import { Button } from "../ui/button";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { McpAppFrame } from "./McpAppFrame";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { useFileContextMenuHandler } from "../../fileContextMenu";
import { useProject, useThreadShell } from "../../state/entities";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantCitationSource } from "./AssistantCitationSource";
import { resolveAssistantMessageCopyState } from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { TimelineRowCtx, TimelineRowActivityCtx, type TimelineRow } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "./TimelineRowParts";

export function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const speechSections = useMemo(
    () =>
      !row.message.streaming && getMessageSpeechPlayer() ? messageSpeechSections(messageText) : [],
    [messageText, row.message.streaming],
  );
  const speechOffsets = useMemo(
    () => speechSections.map((section) => section.startOffset),
    [speechSections],
  );
  const owner = `${ctx.routeThreadKey}:${row.message.id}`;
  const isLatest = ctx.latestSpokenReplyId === row.message.id;
  const renderSpeechSectionActions = useCallback(
    (index: number) => (
      <MessageSpeechSections owner={owner} sections={speechSections} index={index} />
    ),
    [owner, speechSections],
  );

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <MessageAuthorHeading>T3 Code</MessageAuthorHeading>
        <div data-thread-find-text="true">
          <AssistantCitationSource
            messageId={row.message.id}
            {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
            itemKey={row.id}
            request={ctx.citationRequest}
            listRef={ctx.listRef}
          >
            <ChatMarkdown
              text={messageText}
              cwd={ctx.markdownCwd}
              threadRef={ctx.threadRef ?? undefined}
              isStreaming={Boolean(row.message.streaming)}
              lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
              skills={ctx.skills}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
              onUseArtifactTemplate={ctx.onUseArtifactTemplate}
              onRunShellCommand={ctx.onRunShellCommand}
              onImageExpand={ctx.onImageExpand}
              speechSectionOffsets={speechOffsets}
              renderSpeechSectionActions={renderSpeechSectionActions}
            />
          </AssistantCitationSource>
        </div>
        {ctx.onOpenTurnDiff ? (
          <AssistantChangedFilesSection
            turnSummary={row.assistantTurnDiffSummary}
            routeThreadKey={ctx.routeThreadKey}
            resolvedTheme={ctx.resolvedTheme}
            onOpenTurnDiff={ctx.onOpenTurnDiff}
          />
        ) : null}
        {row.showAssistantMeta ? (
          <AssistantMessageMeta
            className="mt-1.5"
            projectedItem={row.projectedItem}
            message={row.message}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
          />
        ) : !row.message.streaming && !ctx.detachedAssistantMetaIds.has(row.message.id) ? (
          <div
            className={cn(
              "mt-1 flex w-full items-center gap-2",
              !isLatest &&
                "opacity-0 max-sm:opacity-100 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
            )}
          >
            {isLatest ? (
              <LatestReplyPlaybackActions message={row.message} />
            ) : (
              <AssistantMessageSpeechActions message={row.message} />
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

function AssistantForkButton({
  projectedItem,
}: {
  readonly projectedItem: NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;
}) {
  const ctx = use(TimelineRowCtx);
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  const canFork = canForkProjectedAssistantItem({
    projectedItem,
    capabilities: support.providerSession?.capabilities,
  });

  const onForkFromRun = ctx.onForkFromRun;
  if (!canFork || onForkFromRun === undefined || projectedItem.item.runId === null) return null;
  const runId = projectedItem.item.runId;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onForkFromRun({ sourceThreadId: projectedItem.sourceThreadId, runId }).finally(
                () => setBusy(false),
              );
            }}
            aria-label="Fork from this response"
          />
        }
      >
        <GitForkIcon className={cn("size-3", busy && "animate-pulse")} />
      </TooltipTrigger>
      <TooltipPopup side="top">Fork from this response</TooltipPopup>
    </Tooltip>
  );
}

export function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        projectedItem={row.projectedItem}
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        alwaysVisible
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  projectedItem,
  message,
  showCopyButton,
  copyStreaming,
  alwaysVisible = false,
}: {
  className?: string;
  projectedItem?: Extract<TimelineRow, { kind: "message" }>["projectedItem"];
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
  alwaysVisible?: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  const isLatest = !message.streaming && ctx.latestSpokenReplyId === message.id;

  return (
    <div className={cn("flex w-full min-w-0 items-center gap-2 text-xs tabular-nums", className)}>
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 transition-opacity duration-200",
          alwaysVisible || isLatest
            ? "opacity-100"
            : "opacity-0 max-sm:opacity-100 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        )}
      >
        {projectedItem?.item.type === "assistant_message" ? (
          <AssistantForkButton projectedItem={projectedItem} />
        ) : null}
        {projectedItem && projectedItem.item.status !== "completed" ? (
          <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
            {projectedItem.item.status}
          </span>
        ) : null}
        <AssistantCopyButton
          message={message}
          showCopyButton={showCopyButton}
          streaming={copyStreaming}
        />
        {!message.streaming && !copyStreaming ? (
          isLatest ? null : (
            <AssistantMessageSpeechActions message={message} />
          )
        ) : null}
        {!message.streaming && (
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="whitespace-nowrap text-muted-foreground text-xs tabular-nums" />
              }
            >
              {formatDayAwareTimestamp(message.updatedAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(message.updatedAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      {isLatest ? <LatestReplyPlaybackActions message={message} /> : null}
    </div>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

export function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
        findActive={ctx.findActive}
      />
    </div>
  );
}

export function HtmlRenderTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "html-render" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { onAppFullscreenChange } = ctx;
  const onFullscreenChange = (fullscreen: boolean) => onAppFullscreenChange(row.id, fullscreen);

  if (ctx.renderHtmlRender) {
    return <div className="min-w-0 px-1">{ctx.renderHtmlRender(row)}</div>;
  }
  return (
    <div className="min-w-0 px-1">
      <HtmlRenderFrame
        key={row.htmlRender.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        htmlRender={row.htmlRender}
        threadRef={ctx.threadRef ?? undefined}
        onFullscreenChange={onFullscreenChange}
      />
    </div>
  );
}

export function McpAppTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "mcp-app" }> }) {
  const ctx = use(TimelineRowCtx);
  const { awaitingUser } = use(TimelineRowActivityCtx);

  return (
    <div className="min-w-0 px-1">
      <McpAppFrame
        key={row.mcpApp.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        threadId={row.sourceThreadId}
        conversationThreadId={ctx.threadRef?.threadId ?? row.sourceThreadId}
        itemId={row.itemId}
        revision={row.revision}
        app={row.mcpApp}
        onSendMessage={ctx.onSendAppMessage}
        awaitingUser={awaitingUser}
        onFullscreenChange={(fullscreen) => ctx.onAppFullscreenChange(row.id, fullscreen)}
      />
    </div>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const ctx = use(TimelineRowCtx);
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.runId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const allDirectoriesExpanded = persistedExpanded ?? false;

  const thread = useThreadShell(ctx.threadRef);
  const activeProject = useProject(
    thread && thread.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
  );
  const onFileContextMenu = useFileContextMenuHandler(ctx.activeThreadEnvironmentId);

  return (
    <ChangedFilesCard
      runId={turnSummary.runId}
      files={checkpointFiles}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onToggleAllDirectories={() =>
        setExpanded(routeThreadKey, turnSummary.runId, !allDirectoriesExpanded)
      }
      onOpenTurnDiff={onOpenTurnDiff}
      onFileContextMenu={(filePath, event) =>
        onFileContextMenu(
          {
            environmentId: ctx.activeThreadEnvironmentId,
            filePath,
            workspaceRoot: ctx.workspaceRoot,
            repositoryRoot:
              thread?.worktreePath == null
                ? activeProject?.repositoryIdentity?.rootPath
                : undefined,
          },
          event,
        )
      }
    />
  );
}

function LatestReplyPlaybackActions({ message }: { message: ChatMessage }) {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <MessageSpeechRateControl />
      <MessageSpeechButton
        owner={`${ctx.routeThreadKey}:${message.id}`}
        text={message.text ?? ""}
        latest
      />
    </div>
  );
}
function AssistantMessageSpeechActions({ message }: { message: ChatMessage }) {
  const ctx = use(TimelineRowCtx);
  const owner = `${ctx.routeThreadKey}:${message.id}`;
  const text = message.text ?? "";
  return (
    <>
      <MessageSpeechButton owner={owner} text={text} />
    </>
  );
}
