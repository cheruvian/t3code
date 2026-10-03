import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Published upstream ids after the shared migration 40, before fork-only additions. */
const upstreamNames = [
  "AuthSessionClientConnection",
  "ProjectionThreadLinkedPullRequest",
  "ProjectionThreadsUnsettledAt",
  "ClearAutomaticProjectModelDefaults",
  "ProjectionProjectsAutoPull",
  "RepairAutomaticSettlementTimestamps",
  "ProjectionProjectIcon",
  "ProjectionThreadBranchPullRequest",
  "ProjectionThreadsActiveOrderKey",
  "ProjectionThreadPullRequests",
  "ProjectionThreadMessageContext",
  "ProjectionThreadTitleState",
  "PullRequestFilesViewed",
  "ProjectionThreadsAutoSettleDisabledAt",
  "OrchestrationV2",
  "RemoveRedundantProjectionIndexes",
];

/** Reconcile known upstream ledgers atomically; never renumber a published fork ledger. */
export const reconcileV2PreviewMigration = <E, R>(
  entries: ReadonlyArray<readonly [number, string, Effect.Effect<unknown, E, R>]>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
        if (tables.length === 0) return [];
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
          readonly created_at: string;
        }>`
      SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id
    `;
        const forkNames = new Map(entries.map(([id, name]) => [id, name]));
        const matches = (names: ReadonlyMap<number, string>) =>
          history.every(
            (row, index) =>
              row.migration_id === index + 1 && names.get(row.migration_id) === row.name,
          );
        if (matches(forkNames)) return [];
        const upstream = new Map(
          entries.filter(([id]) => id <= 40).map(([id, name]) => [id, name]),
        );
        upstreamNames.forEach((name, index) => upstream.set(index + 41, name));
        const preview53 = new Map([...upstream].filter(([id]) => id <= 52));
        preview53.set(53, "OrchestrationV2");
        const preview54 = new Map([...upstream].filter(([id]) => id <= 53));
        preview54.set(54, "OrchestrationV2");
        preview54.set(55, "RemoveRedundantProjectionIndexes");
        if (![upstream, preview53, preview54].some(matches)) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message:
              "Cannot upgrade an unrecognized migration ledger; database history was left unchanged.",
          });
        }
        const recorded = new Map(history.map((row) => [row.name, row]));
        const executed: Array<readonly [number, string]> = [];
        // Keep the existing V2 schema and lazy-import progress. Run only absent
        // migrations, including fork additions below upstream's highest recorded id.
        for (const [id, name, migration] of entries) {
          if (recorded.has(name)) continue;
          yield* migration;
          executed.push([id, name]);
        }
        yield* sql`DELETE FROM effect_sql_migrations`;
        for (const [id, name] of entries) {
          const original = recorded.get(name);
          if (original) {
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (${id}, ${name}, ${original.created_at})`;
          } else {
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
          }
        }
        return executed;
      }),
    );
  });
