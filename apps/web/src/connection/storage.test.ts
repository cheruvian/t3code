import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  StoredOrchestrationShellSnapshot,
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  ConnectionCatalogDocument,
  Persistence,
  registerConnectionInCatalog,
} from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../test-fixtures";
import * as ConnectionStorage from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectionStorage.makeCatalogStore", () => {
  it.effect("preserves an unreadable catalog and rejects reads and writes", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const raw = encodeUnknownJson({
        ...emptyCatalog,
        targets: [
          {
            _tag: "BearerConnectionTarget",
            environmentId: "remote-1",
            label: "One",
            connectionId: "one",
          },
          { _tag: "BearerConnectionTarget", environmentId: "remote-2", label: "Two" },
        ],
      });
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(raw),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect((yield* Effect.flip(store.read)).message).toContain("data was preserved");
      expect((yield* Effect.flip(store.update((document) => document))).message).toContain(
        "data was preserved",
      );
      expect(quarantined).toEqual([raw, raw]);
      expect(writes).toEqual([]);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );

  it.effect("merges writes from clients that opened before another pairing was saved", () =>
    Effect.gen(function* () {
      let raw = encodeCatalog(emptyCatalog);
      const backend = {
        read: Effect.sync(() => raw),
        write: (next: string) =>
          Effect.sync(() => {
            raw = next;
          }),
      };
      const first = yield* ConnectionStorage.makeCatalogStore(backend);
      const second = yield* ConnectionStorage.makeCatalogStore(backend);
      yield* first.read;
      yield* second.read;

      const registration = (environmentId: string) => {
        const id = EnvironmentId.make(environmentId);
        const connectionId = `${environmentId}-connection`;
        return new BearerConnectionRegistration({
          target: new BearerConnectionTarget({
            environmentId: id,
            label: environmentId,
            connectionId,
          }),
          profile: new BearerConnectionProfile({
            environmentId: id,
            label: environmentId,
            connectionId,
            httpBaseUrl: `https://${environmentId}.example.test`,
            wsBaseUrl: `wss://${environmentId}.example.test`,
          }),
          credential: new BearerConnectionCredential({ token: `${environmentId}-token` }),
        });
      };

      yield* first.update((document) => registerConnectionInCatalog(document, registration("one")));
      yield* second.update((document) =>
        registerConnectionInCatalog(document, registration("two")),
      );

      const saved = decodeCatalog(raw);
      expect(saved.targets.map((target) => target.environmentId)).toEqual(["one", "two"]);
      expect(saved.profiles).toHaveLength(2);
      expect(saved.credentials).toHaveLength(2);
    }),
  );
});

const fixedHandle = (database: IDBDatabase) => ({
  get: Effect.succeed(database),
  invalidate: () => Effect.void,
});

describe("ConnectionStorage.makeCatalogBackend", () => {
  it.effect("reports a closed IndexedDB connection as a typed read and write failure", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const database = {
        transaction: () => {
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      } as unknown as IDBDatabase;
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle(database));

      const readError = yield* Effect.flip(backend.read);
      const writeError = yield* Effect.flip(backend.write("{}"));

      expect(readError).toBeInstanceOf(ConnectionTransientError);
      expect(readError.message).toContain("The database connection is closing.");
      expect(writeError).toBeInstanceOf(ConnectionTransientError);
    }),
  );

  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle({} as IDBDatabase));

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );

  it.effect("fails IndexedDB writes whose commit aborts", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          put: () => {
            // A failed commit aborts the transaction without an "error" event.
            queueMicrotask(() => {
              transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
              transaction.dispatchEvent(new Event("abort"));
            });
          },
        }),
      });
      const backend = ConnectionStorage.makeCatalogBackend(
        fixedHandle({ transaction: () => transaction } as unknown as IDBDatabase),
      );

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error.message).toContain("QuotaExceededError");
    }),
  );
});

describe("environment cache removal", () => {
  it.effect("fails both removal operations when IndexedDB aborts their commits", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      vi.stubGlobal("IDBKeyRange", { bound: () => ({}) });
      const database = Object.assign(new EventTarget(), {
        transaction: () => {
          const transaction = Object.assign(new EventTarget(), {
            error: new DOMException("Commit aborted", "AbortError"),
            objectStore: () => ({
              delete: () => queueMicrotask(() => transaction.dispatchEvent(new Event("abort"))),
              openCursor: () => {
                queueMicrotask(() => transaction.dispatchEvent(new Event("abort")));
                return new EventTarget();
              },
            }),
          });
          return transaction;
        },
        close: vi.fn(),
      }) as unknown as IDBDatabase;
      const openRequest = Object.assign(new EventTarget(), { result: database, error: null });
      vi.stubGlobal("indexedDB", {
        open: () => {
          queueMicrotask(() => openRequest.dispatchEvent(new Event("success")));
          return openRequest;
        },
      });

      const [threadError, refsError] = yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        return [
          yield* Effect.flip(
            cache.removeThread(EnvironmentId.make("env"), ThreadId.make("thread")),
          ),
          yield* Effect.flip(cache.clearVcsRefs(EnvironmentId.make("env"))),
        ] as const;
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(threadError.message).toContain("Commit aborted");
      expect(refsError.message).toContain("Commit aborted");
      expect(database.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection recovery", () => {
  it.effect("reports an initial open failure from the cache operation", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const open = vi.fn(() => {
        throw new DOMException("Storage is unavailable", "InvalidStateError");
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        expect(open).not.toHaveBeenCalled();
        const error = yield* Effect.flip(
          cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread")),
        );
        expect(error.message).toContain("Storage is unavailable");
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(open).toHaveBeenCalledOnce();
    }),
  );

  it.effect("reopens after a forced close and finalizes the current connection", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const makeDatabase = () =>
        Object.assign(new EventTarget(), {
          close: vi.fn(),
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const request = Object.assign(new EventTarget(), {
                  result: undefined,
                  error: null,
                });
                queueMicrotask(() => request.dispatchEvent(new Event("success")));
                return request;
              },
            }),
          }),
        }) as unknown as IDBDatabase;
      const first = makeDatabase();
      const second = makeDatabase();
      const databases = [first, second];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const environmentId = EnvironmentId.make("env");
        const threadId = ThreadId.make("thread");
        expect(Option.isNone(yield* cache.loadThread(environmentId, threadId))).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);

        first.dispatchEvent(new Event("close"));
        const recovered = yield* Effect.all(
          [cache.loadThread(environmentId, threadId), cache.loadThread(environmentId, threadId)],
          { concurrency: 2 },
        );
        expect(recovered.every(Option.isNone)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection closed without a close event", () => {
  it.effect("reopens and retries the failing operation once", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const closing = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => {
          // Chromium force-closed this connection; this tab never saw "close".
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      }) as unknown as IDBDatabase;
      const fresh = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const request = Object.assign(new EventTarget(), { result: undefined, error: null });
              queueMicrotask(() => request.dispatchEvent(new Event("success")));
              return request;
            },
          }),
        }),
      }) as unknown as IDBDatabase;
      const databases = [closing, fresh];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const loaded = yield* cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread"));
        expect(Option.isNone(loaded)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );
});

describe("browser GitHub routing permissions", () => {
  it.effect("revokes across runtimes before storage events and resists stale catalog writes", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const localStorage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const firstBrowser = Object.assign(new EventTarget(), { localStorage });
      const secondBrowser = Object.assign(new EventTarget(), { localStorage });
      const first = ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser);
      const second = ConnectionStorage.makeBrowserGitHubRoutingPermissions(secondBrowser);
      const entry = {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("first"),
          label: "First",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const other = {
        ...entry,
        target: new PrimaryConnectionTarget({
          ...entry.target,
          environmentId: EnvironmentId.make("second"),
        }),
      };
      expect(yield* first.get(entry)).toBe("off");
      yield* first.set(entry, "read-write");
      expect(yield* second.get(entry)).toBe("read-write");
      const oldPermissions = Option.getOrThrow(yield* Stream.runHead(first.changes));
      const staleCatalog = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(
          encodeCatalog({ ...emptyCatalog, githubRoutingPermissions: oldPermissions }),
        ),
        write: () => Effect.void,
      });
      yield* staleCatalog.read;
      const listening = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      yield* second.changes.pipe(
        Stream.runForEach((permissions) =>
          Deferred.succeed(permissions.length > 0 ? listening : revoked, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(listening);

      yield* first.set(entry, "off");
      expect(yield* second.get(entry)).toBe("off");
      secondBrowser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      yield* Deferred.await(revoked);
      yield* second.set(other, "read");
      yield* staleCatalog.update((document) => ({ ...document, accountId: "updated" }));
      expect(yield* second.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      expect(
        yield* ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser).get(entry),
      ).toBe("off");

      yield* first.set(entry, "read-write");
      yield* second.forget(entry.target.environmentId);
      expect(yield* first.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(yield* first.set(entry, "read-write").pipe(Effect.flip)).toBeInstanceOf(
        ConnectionTransientError,
      );
      expect(yield* second.get(entry)).toBe("off");
    }).pipe(Effect.scoped),
  );
});

const v2Projection = makeThreadProjectionFixture();
const v2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  archivedThreads: [],
  threads: [
    {
      ...v2Projection.thread,
      latestRunId: null,
      activeRunId: null,
      status: "idle" as const,
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
    },
  ],
};

const encodeLegacyShellSnapshot = Schema.encodeSync(
  Schema.fromJsonString(StoredOrchestrationShellSnapshot),
);

function installSnapshotDatabase(options?: {
  legacy?: boolean;
  rejectOptions?: boolean;
  abort?: boolean;
}) {
  vi.stubGlobal("window", {});
  const values = new Map<string, unknown>();
  if (options?.legacy)
    values.set(
      "shell:cache-env",
      encodeLegacyShellSnapshot({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId: EnvironmentId.make("cache-env"),
        snapshot: v2ShellSnapshot,
      }),
    );
  const transactions: Array<{ store: string; options: IDBTransactionOptions | undefined }> = [];
  const database = Object.assign(new EventTarget(), {
    close: vi.fn(),
    transaction: (store: string, _mode: string, transactionOptions?: IDBTransactionOptions) => {
      transactions.push({ store, options: transactionOptions });
      if (options?.rejectOptions && transactionOptions)
        throw new TypeError("Options not supported");
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          get: (key: string) => {
            const request = Object.assign(new EventTarget(), {
              result: structuredClone(values.get(`${store}:${key}`)),
              error: null,
            });
            queueMicrotask(() => request.dispatchEvent(new Event("success")));
            return request;
          },
          put: (value: unknown, key: string) => {
            if (!options?.abort) values.set(`${store}:${key}`, structuredClone(value));
            queueMicrotask(() => {
              if (options?.abort)
                transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
              transaction.dispatchEvent(new Event(options?.abort ? "abort" : "complete"));
            });
          },
          delete: (key: string) => {
            values.delete(`${store}:${key}`);
            queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
          },
        }),
      });
      return transaction;
    },
  }) as unknown as IDBDatabase;
  const request = Object.assign(new EventTarget(), { result: database, error: null });
  vi.stubGlobal("indexedDB", {
    open: () => {
      queueMicrotask(() => request.dispatchEvent(new Event("success")));
      return request;
    },
  });
  return { values, transactions };
}

describe("disposable snapshot persistence", () => {
  it.effect.each([false, true])(
    "round-trips JSON snapshots with default-option fallback: %s",
    (rejectOptions) => {
      const { values, transactions } = installSnapshotDatabase({ rejectOptions });
      return Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const environmentId = EnvironmentId.make("cache-env");
        const thread = {
          snapshotSequence: 2,
          projection: v2Projection,
          hasMoreHistory: true,
          historyCursor: "older",
          latestLocalTurnOrdinal: 4,
        };
        yield* cache.saveShell(environmentId, v2ShellSnapshot);
        yield* cache.saveThread(environmentId, thread);
        expect(typeof values.get("shell:cache-env")).toBe("string");
        expect(Option.getOrThrow(yield* cache.loadShell(environmentId))).toMatchObject(
          v2ShellSnapshot,
        );
        expect(
          Option.getOrThrow(yield* cache.loadThread(environmentId, v2Projection.thread.id)),
        ).toMatchObject(thread);
        expect(
          transactions.filter((tx) => tx.options?.durability === "relaxed").map((tx) => tx.store),
        ).toEqual(["shell", "thread"]);
        if (rejectOptions)
          expect(transactions.filter((tx) => tx.options === undefined)).toHaveLength(4);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    },
  );

  it.effect("loads existing JSON snapshots and discards invalid caches", () => {
    const { values } = installSnapshotDatabase({ legacy: true });
    return Effect.gen(function* () {
      const cache = yield* Persistence.EnvironmentCacheStore;
      const id = EnvironmentId.make("cache-env");
      expect(Option.getOrThrow(yield* cache.loadShell(id))).toMatchObject(v2ShellSnapshot);
      values.set(
        "shell:cache-env",
        JSON.stringify({
          schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
          environmentId: id,
          snapshot: { threads: "invalid" },
        }),
      );
      expect(Option.isNone(yield* cache.loadShell(id))).toBe(true);
      expect(values.has("shell:cache-env")).toBe(false);
    }).pipe(Effect.provide(ConnectionStorage.layer));
  });

  it.effect("reports aborted snapshot commits and leaves catalog durability unchanged", () => {
    const { transactions } = installSnapshotDatabase({ abort: true });
    return Effect.gen(function* () {
      const cache = yield* Persistence.EnvironmentCacheStore;
      expect(
        (yield* cache.saveShell(EnvironmentId.make("cache-env"), v2ShellSnapshot).pipe(Effect.flip))
          .message,
      ).toContain("QuotaExceededError");
      // Credential-bearing catalog writes still use the browser's normal transaction policy.
      const database = yield* Effect.callback<IDBDatabase>((resume) => {
        const request = indexedDB.open("test");
        request.addEventListener("success", () => resume(Effect.succeed(request.result)));
      });
      yield* ConnectionStorage.makeCatalogBackend(fixedHandle(database))
        .write("{}")
        .pipe(Effect.flip);
      expect(transactions.filter((tx) => tx.store === "catalog")).toEqual([
        { store: "catalog", options: undefined },
      ]);
    }).pipe(Effect.provide(ConnectionStorage.layer));
  });
});
