import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  applyPreviewServerEvent,
  readThreadPreviewState,
  reconcilePreviewEnvironmentSessions,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { recordBrowserAttachment } from "./browserAttachmentTelemetry";

// The hosting desktop must hear about agent tabs even when their thread is not viewed.
export const desktopPreviewSyncAtom = Atom.family((environmentId: EnvironmentId) => {
  const sessions = previewEnvironment.list({ environmentId, input: {} });
  const events = previewEnvironment.events({ environmentId, input: {} });
  return Atom.make((get) => {
    let discoveryState = "";
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    get.addFinalizer(() => clearTimeout(refreshTimer));
    recordBrowserAttachment("discovery-start", { environmentId });
    get.addFinalizer(() => recordBrowserAttachment("discovery-stop", { environmentId }));
    get.subscribe(sessions, (result) => {
      clearTimeout(refreshTimer);
      // Silent event delivery must not strand background tabs; wait for each list to settle.
      if (!result.waiting) {
        refreshTimer = setTimeout(() => get.refresh(sessions), 10_000);
      }
      if (AsyncResult.isSuccess(result)) {
        recordBrowserAttachment("list-received", {
          environmentId,
          scope: "environment",
          serverEpoch: result.value.serverEpoch,
          revision: result.value.revision,
          sessionCount: result.value.sessions.length,
          tabIds: JSON.stringify(result.value.sessions.map((session) => session.tabId)),
          waiting: result.waiting,
        });
        if (!result.waiting) reconcilePreviewEnvironmentSessions(environmentId, result.value);
      }
    });
    get.subscribe(events, (result) => {
      const state = `${result._tag}:${result.waiting}`;
      if (state !== discoveryState) {
        discoveryState = state;
        recordBrowserAttachment("discovery-state", {
          environmentId,
          state: result._tag,
          waiting: result.waiting,
        });
      }
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "opened") {
        recordBrowserAttachment("event-received", {
          environmentId,
          threadId: event.threadId,
          tabId: event.tabId,
          serverEpoch: event.serverEpoch,
          revision: event.revision,
        });
      }
      const ref = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
      const epoch = readThreadPreviewState(ref).serverEpoch;
      if (epoch !== null && epoch !== event.serverEpoch) {
        if (!get.once(sessions).waiting) get.refresh(sessions);
      } else applyPreviewServerEvent(ref, event);
      if (event.type === "opened") {
        recordBrowserAttachment("event-applied", {
          environmentId,
          threadId: event.threadId,
          tabId: event.tabId,
          epochMatched: epoch === null || epoch === event.serverEpoch,
          sessionKnown: readThreadPreviewState(ref).sessions[event.tabId] !== undefined,
        });
      }
    });
    get.mount(events);
    get.mount(sessions);
    const current = get.once(sessions);
    if (!AsyncResult.isInitial(current) && !current.waiting) get.refresh(sessions);
  }).pipe(Atom.setIdleTTL(0));
});
