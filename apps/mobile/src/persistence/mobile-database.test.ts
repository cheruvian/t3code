import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ OS: "ios" }));

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));
vi.mock("react-native", () => ({ Platform: platform }));

import * as MobileDatabase from "./mobile-database";

describe("mobile database legacy cache migration", () => {
  it("maps legacy thread records to their SQLite identity", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: "environment-1",
      threadId: "thread-1",
      snapshot: {},
    });

    expect(MobileDatabase.decodeLegacyCacheRecord("connection-thread-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "thread",
      cacheKey: "thread-1",
      schemaVersion: 2,
      payload,
    });
  });

  it("skips malformed legacy records", () => {
    expect(MobileDatabase.decodeLegacyCacheRecord("connection-vcs-refs", "{not-json")).toBeNull();
    expect(
      MobileDatabase.decodeLegacyCacheRecord(
        "connection-vcs-refs",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1" }),
      ),
    ).toBeNull();
  });
});

describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase(web = false) {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    if (!web) sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        if (web) throw new Error("withExclusiveTransactionAsync is not supported on web");
        await run(database);
      },
      withTransactionAsync: async (run: () => Promise<void>) => {
        sqlite.exec("BEGIN");
        try {
          await run();
          sqlite.exec("COMMIT");
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("initializes a fresh browser database and persists cached records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        platform.OS = "web";
        const sqlite = yield* Effect.promise(() => sqliteDatabase(true));
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "thread", "browser-thread", 1, "browser cache");
        expect(yield* database.loadCache(environmentId, "thread", "browser-thread")).toEqual(
          Option.some("browser cache"),
        );
        expect(sqlite.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          platform.OS = "ios";
        }),
      ),
    ),
  );

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(() => sqliteDatabase());
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
        yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
        expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
          Option.some('{"entries":[]}'),
        );
        yield* database.clearEnvironmentCache(environmentId);
        expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
          "None",
        );
        expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
          "Some",
        );
      }),
    ),
  );

  it.effect(
    "expires old records and bounds count and payload size without evicting other cache kinds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sqlite = yield* Effect.promise(() => sqliteDatabase());
          const database = yield* MobileDatabase.make;
          yield* database.saveCache(environmentId, "thread", "thread", 1, "thread");
          yield* database.saveCache(environmentId, "pull-request", "old", 1, "old");
          sqlite.prepare("UPDATE client_cache SET updated_at = 0 WHERE cache_key = 'old'").run();
          expect((yield* database.loadCache(environmentId, "pull-request", "old"))._tag).toBe(
            "None",
          );
          for (let i = 0; i < 260; i++)
            yield* database.saveCache(environmentId, "pull-request", `page-${i}`, 1, "page");
          expect((yield* database.listCache("pull-request")).length).toBe(256);
          const large = "x".repeat(4 * 1024 * 1024);
          for (let i = 0; i < 10; i++)
            yield* database.saveCache(environmentId, "pull-request", `diff-${i}`, 1, large);
          const summary = yield* database.inspectCaches;
          const prs = summary.find((row) => row.kind === "pull-request");
          expect(prs?.payloadBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
          expect(prs?.recordCount).toBeLessThanOrEqual(256);
          expect((yield* database.loadCache(environmentId, "thread", "thread"))._tag).toBe("Some");
          yield* database.saveCache(environmentId, "pull-request", "oversized", 1, large + "x");
          expect((yield* database.loadCache(environmentId, "pull-request", "oversized"))._tag).toBe(
            "None",
          );
        }),
      ),
  );
});
