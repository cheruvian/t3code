import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import {
  ConnectionCatalogDocument,
  registerConnectionInCatalog,
} from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";

import {
  makeBrowserGitHubRoutingPermissions,
  makeCatalogBackend,
  makeCatalogStore,
} from "./storage";

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

describe("makeCatalogStore", () => {
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
      const store = yield* makeCatalogStore({
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
      const store = yield* makeCatalogStore({
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
      const first = yield* makeCatalogStore(backend);
      const second = yield* makeCatalogStore(backend);
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

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
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
      const first = makeBrowserGitHubRoutingPermissions(firstBrowser);
      const second = makeBrowserGitHubRoutingPermissions(secondBrowser);
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
      const staleCatalog = yield* makeCatalogStore({
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
      expect(yield* makeBrowserGitHubRoutingPermissions(firstBrowser).get(entry)).toBe("off");

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
