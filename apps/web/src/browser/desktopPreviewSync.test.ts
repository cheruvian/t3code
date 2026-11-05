import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { EnvironmentId, type PreviewEvent, type PreviewListResult } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    list: (target: unknown) => {
      listTargets.push(target);
      return baseline;
    },
    events: () => events,
  },
}));

import { desktopPreviewSyncAtom } from "./desktopPreviewSync";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readActivePreviewSessions, resetPreviewStateForTests } from "~/previewStateStore";

const emptyList: PreviewListResult = { sessions: [], serverEpoch: "server-a", revision: 0 };
let serverList = emptyList;
let pendingList: Promise<PreviewListResult> | undefined;
const listTargets: unknown[] = [];
const listRequest = vi.fn(() => pendingList ?? Promise.resolve(serverList));
const baseline = Atom.make(() => Effect.tryPromise(listRequest)).pipe(Atom.setIdleTTL(0));
const events = Atom.make<AsyncResult.AsyncResult<PreviewEvent>>(AsyncResult.initial());
let unmountHost = () => {};

const readList = () => executeAtomQuery(appAtomRegistry, baseline);
async function mountHost() {
  unmountHost = appAtomRegistry.mount(desktopPreviewSyncAtom(EnvironmentId.make("host")));
  await readList();
}
const hostedSessions = () =>
  Object.values(readActivePreviewSessions()).flatMap((state) => Object.values(state.sessions));
function deferredList() {
  let resolve!: (value: PreviewListResult) => void;
  const promise = new Promise<PreviewListResult>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  unmountHost();
  unmountHost = () => {};
  resetPreviewStateForTests();
  appAtomRegistry.reset();
  serverList = emptyList;
  pendingList = undefined;
  listRequest.mockReset();
  listRequest.mockImplementation(() => pendingList ?? Promise.resolve(serverList));
  listTargets.length = 0;
  vi.useRealTimers();
});

const backgroundSession = {
  threadId: "unviewed-thread",
  tabId: "silent-tab",
  runtime: "server" as const,
  navStatus: { _tag: "Success" as const, url: "https://example.test", title: "Test" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-11-05T19:31:52Z",
};

it("recovers a background open on the first reconciliation with event delivery withheld", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await mountHost();
  expect(hostedSessions()).toHaveLength(0);
  const initialRequests = listRequest.mock.calls.length;
  serverList = { ...emptyList, revision: 1, sessions: [backgroundSession] };

  await vi.advanceTimersByTimeAsync(10_000);

  expect(listRequest).toHaveBeenCalledTimes(initialRequests + 1);
  const discovered = hostedSessions();
  expect(discovered).toHaveLength(1);
  expect(discovered[0]?.tabId).toBe("silent-tab");
  expect(
    listTargets.every(
      (target) => JSON.stringify(target) === JSON.stringify({ environmentId: "host", input: {} }),
    ),
  ).toBe(true);
  expect(AsyncResult.isInitial(appAtomRegistry.get(events))).toBe(true);

  serverList = { ...emptyList, revision: 2 };
  await vi.advanceTimersByTimeAsync(10_000);
  expect(hostedSessions()).toHaveLength(0);
});

it("does not overlap slow reconciliation and stops refreshing when the host unmounts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await mountHost();
  const response = deferredList();
  pendingList = response.promise;
  const initialRequests = listRequest.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(listRequest).toHaveBeenCalledTimes(initialRequests + 1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(listRequest).toHaveBeenCalledTimes(initialRequests + 1);

  pendingList = undefined;
  response.resolve({ ...emptyList, revision: 1, sessions: [backgroundSession] });
  await readList();
  expect(hostedSessions()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(listRequest).toHaveBeenCalledTimes(initialRequests + 2);
  unmountHost();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(listRequest).toHaveBeenCalledTimes(initialRequests + 2);
});

it("retries a failed list and accepts a restarted server with a lower revision", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  serverList = { ...emptyList, revision: 20, sessions: [backgroundSession] };
  await mountHost();
  expect(hostedSessions()).toHaveLength(1);
  listRequest.mockRejectedValueOnce(new Error("Disconnected"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(hostedSessions()).toHaveLength(1);

  serverList = { ...emptyList, revision: 19 };
  await vi.advanceTimersByTimeAsync(10_000);
  expect(hostedSessions()).toHaveLength(1);
  serverList = { ...emptyList, serverEpoch: "server-b" };
  await vi.advanceTimersByTimeAsync(10_000);
  expect(hostedSessions()).toHaveLength(0);
});

it("disposes during an in-flight list and resumes discovery on remount", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await mountHost();
  const response = deferredList();
  pendingList = response.promise;
  await vi.advanceTimersByTimeAsync(10_000);
  unmountHost();
  await vi.advanceTimersByTimeAsync(0);
  const requestsAtUnmount = listRequest.mock.calls.length;
  serverList = { ...emptyList, revision: 1, sessions: [backgroundSession] };
  pendingList = undefined;
  response.resolve(serverList);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(listRequest).toHaveBeenCalledTimes(requestsAtUnmount);
  expect(hostedSessions()).toHaveLength(0);
  await mountHost();
  expect(hostedSessions()).toHaveLength(1);
  const requestsAtRemount = listRequest.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(listRequest).toHaveBeenCalledTimes(requestsAtRemount + 1);
});

it("does not restart an in-flight reconciliation for repeated new-epoch events", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  serverList = { ...emptyList, revision: 20, sessions: [backgroundSession] };
  await mountHost();
  const response = deferredList();
  pendingList = response.promise;
  await vi.advanceTimersByTimeAsync(10_000);
  const requestsWhilePending = listRequest.mock.calls.length;
  for (const revision of [1, 2]) {
    appAtomRegistry.set(
      events,
      AsyncResult.success({
        type: "opened",
        threadId: backgroundSession.threadId,
        tabId: backgroundSession.tabId,
        snapshot: backgroundSession,
        createdAt: backgroundSession.updatedAt,
        serverEpoch: "server-b",
        revision,
      }),
    );
  }
  expect(listRequest).toHaveBeenCalledTimes(requestsWhilePending);
  pendingList = undefined;
  serverList = { ...emptyList, serverEpoch: "server-b", revision: 2 };
  response.resolve(serverList);
  await readList();
  expect(hostedSessions()).toHaveLength(0);
});
