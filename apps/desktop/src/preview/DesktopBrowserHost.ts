import { DESKTOP_CREDENTIAL_ENTRY_COMMAND } from "@t3tools/contracts";
import {
  closeCredentialEntry,
  credentialEntryActive,
  credentialEntryEpoch,
  setCredentialEntryPrivacy,
} from "./CredentialEntryPrivacy.ts";
// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/**
 * The preview manager owns the tab's single debugger session and hands it here;
 * the relay shares it.
 */
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserEvent as DesktopBrowserEventType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";
import { sendPageCommand } from "./GuestInput.ts";
import { withCaptureRendering } from "./CaptureRendering.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
  readonly canEnterCredentialMode?: () => Promise<boolean>;
}

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

interface AttachedTab {
  captureAbort: AbortController;
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    readonly events: Stream.Stream<Uint8Array>;
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    readonly detach: (key: DesktopBrowserTabKey) => void;
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export interface PrivateBrowserPage {
  readonly debuggee: DesktopBrowserTabDebugger;
  readonly close: () => void;
}

export async function createPrivateBrowserPage(
  source: DesktopBrowserTabDebugger,
): Promise<PrivateBrowserPage> {
  const { BrowserWindow } = await import("electron");
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: source.webContents.session,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadURL("about:blank");
    window.webContents.debugger.attach("1.3");
    return {
      debuggee: { webContents: window.webContents, debugger: window.webContents.debugger },
      close: () => {
        if (!window.isDestroyed()) window.destroy();
      },
    };
  } catch {
    window.destroy();
    throw new Error("Private desktop browser page could not start.");
  }
}

export const makeWithPrivatePages = (createPrivatePage = createPrivateBrowserPage) =>
  Effect.gen(function* () {
    const outbox = yield* PubSub.unbounded<DesktopBrowserEventType>();
    const pointers = yield* PubSub.sliding<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>(16);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const tabs = new Map<string, AttachedTab>();
    const privatePages = new Map<string, { source: string; page?: PrivateBrowserPage }>();
    const emit = (event: DesktopBrowserEventType) => runFork(PubSub.publish(outbox, event));

    const relayFor = (tab: AttachedTab) => {
      if (tab.relay) return tab.relay;
      const { webContents, debugger: debuggee } = tab.debuggee;
      const relay: CdpRelayConnection = createCdpRelayConnection(
        {
          send: (method, params, sessionId) => {
            if (method === DESKTOP_CREDENTIAL_ENTRY_COMMAND)
              return setCredentialEntryPrivacy(
                webContents,
                params.active === true,
                tab.debuggee.canEnterCredentialMode,
              ).then(() => ({}));
            if (method === "Page.captureScreenshot" && credentialEntryActive(webContents.id))
              return Promise.reject(new Error("Private credential entry is in progress."));
            const send = () =>
              sessionId === undefined
                ? sendPageCommand(webContents, debuggee, method, params)
                : debuggee.sendCommand(method, params, sessionId);
            const epoch = credentialEntryEpoch(webContents.id);
            return method === "Page.captureScreenshot"
              ? withCaptureRendering(
                  webContents,
                  send,
                  AbortSignal.any([tab.captureAbort.signal, AbortSignal.timeout(10_000)]),
                ).then((result) => {
                  if (
                    credentialEntryActive(webContents.id) ||
                    epoch !== credentialEntryEpoch(webContents.id)
                  )
                    throw new Error("Browser privacy changed.");
                  return result;
                })
              : send();
          },
          targetId: () =>
            debuggee
              .sendCommand("Target.getTargetInfo")
              .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
          url: () => webContents.getURL(),
          title: () => webContents.getTitle(),
          userAgent: () => webContents.getUserAgent(),
          setDownloadDirectory: (directory) => {
            tab.downloadDirectory = directory;
          },
        },
        (message) => {
          if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
            emit({ type: "cdp", ...tab.key, message });
          }
        },
      );
      tab.relay = relay;
      return relay;
    };

    /**
     * Without a path Electron would open its Save dialog over the app for a file
     * the agent asked for. CDP names the download just before this runs.
     */
    const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
      const tab = [...tabs.values()].find(
        (candidate) => candidate.debuggee.webContents === source && candidate.downloadDirectory,
      );
      if (!tab?.downloadDirectory || !tab.pendingDownloadGuid) return false;
      item.setSavePath(NodePath.join(tab.downloadDirectory, tab.pendingDownloadGuid));
      tab.pendingDownloadGuid = null;
      return true;
    };

    const detach = (key: DesktopBrowserTabKey) => {
      const id = keyOf(key);
      for (const [privateId, entry] of privatePages) {
        if (privateId !== id && entry.source !== id) continue;
        privatePages.delete(privateId);
        entry.page?.close();
        if (privateId !== id)
          detach({ threadId: key.threadId, tabId: privateId.split("\u0000")[1]! });
      }
      const tab = tabs.get(id);
      if (!tab) return;
      closeCredentialEntry(tab.debuggee.webContents);
      tab.captureAbort.abort();
      tabs.delete(id);
      tab.debuggee.debugger.off("message", tab.onMessage);
      emit({ type: "detached", ...key });
    };

    const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
      const id = keyOf(key);
      if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
      if (tabs.has(id)) detach(key);
      const tab: AttachedTab = {
        captureAbort: new AbortController(),
        key,
        debuggee,
        relay: null,
        downloadDirectory: null,
        pendingDownloadGuid: null,
        agentInputAt: Number.NEGATIVE_INFINITY,
        onMessage: (_event, method, params, sessionId) => {
          if (method === "Browser.downloadWillBegin") {
            const guid = (params as { guid?: unknown } | undefined)?.guid;
            tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
          }
          tab.relay?.event(method, params, sessionId);
        },
      };
      tabs.set(id, tab);
      debuggee.debugger.on("message", tab.onMessage);
      emit({ type: "attached", ...key });
    };

    const handleCommandLine = (line: string) =>
      Effect.sync(() => {
        const command = decodeCommand(line);
        if (Option.isNone(command)) return;
        const value = command.value;
        const commandKey = { threadId: value.threadId, tabId: value.tabId };
        if (value.type === "private-close") {
          if (privatePages.has(keyOf(value))) detach(commandKey);
          return;
        }
        if (value.type === "private-open") {
          const sourceKey = { threadId: value.threadId, tabId: value.sourceTabId };
          const source = tabs.get(keyOf(sourceKey));
          const id = keyOf(value);
          if (!source || privatePages.has(keyOf(sourceKey)) || tabs.has(id) || privatePages.has(id))
            return;
          const entry: { source: string; page?: PrivateBrowserPage } = { source: keyOf(sourceKey) };
          privatePages.set(id, entry);
          void createPrivatePage(source.debuggee)
            .then((page) => {
              if (privatePages.get(id) !== entry || tabs.get(keyOf(sourceKey)) !== source) {
                page.close();
                return;
              }
              entry.page = page;
              page.debuggee.webContents.once("destroyed", () => detach(commandKey));
              attach(commandKey, page.debuggee);
            })
            .catch(() => {
              if (privatePages.get(id) === entry) privatePages.delete(id);
              emit({ type: "detached", threadId: value.threadId, tabId: value.tabId });
            });
          return;
        }
        const tab = tabs.get(keyOf(value));
        if (!tab) return;
        if (value.type === "pointer") {
          const { threadId, tabId, phase, x, y } = value;
          runFork(PubSub.publish(pointers, { key: { threadId, tabId }, phase, x, y }));
          return;
        }
        if (value.type === "release") {
          closeCredentialEntry(tab.debuggee.webContents);
          tab.captureAbort.abort();
          tab.captureAbort = new AbortController();
          tab.relay = null;
          return;
        }
        if (AGENT_INPUT_COMMAND.test(value.message)) tab.agentInputAt = performance.now();
        relayFor(tab).receive(value.message);
      });

    const humanStartedDownload = (source: Electron.WebContents) => {
      const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
      return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS;
    };

    const announceAll = Effect.suspend(() => {
      for (const id of privatePages.keys()) {
        const [threadId, tabId] = id.split("\u0000");
        detach({ threadId: threadId!, tabId: tabId! });
      }
      return Effect.forEach(
        [...tabs.values()],
        (tab) => {
          closeCredentialEntry(tab.debuggee.webContents);
          tab.captureAbort.abort();
          tab.captureAbort = new AbortController();
          tab.relay = null;
          return PubSub.publish(outbox, { type: "attached", ...tab.key });
        },
        { discard: true },
      );
    });

    return DesktopBrowserHost.of({
      pointers: Stream.fromPubSub(pointers),
      // Subscribes before announcing, so no attach falls between the two.
      events: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(outbox);
          yield* announceAll;
          return Stream.fromSubscription(subscription);
        }),
      ).pipe(Stream.map((event) => lineEncoder.encode(`${encodeEvent(event)}\n`))),
      handleCommandLine,
      attach,
      detach,
      placeDownload,
      humanStartedDownload,
    });
  });

export const make = makeWithPrivatePages();

export const layer = Layer.effect(DesktopBrowserHost, make);
