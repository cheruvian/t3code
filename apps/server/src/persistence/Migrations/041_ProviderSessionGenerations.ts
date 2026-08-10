import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const runtimeColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!runtimeColumns.some((column) => column.name === "owner_generation")) {
    yield* sql`ALTER TABLE provider_session_runtime ADD COLUMN owner_generation TEXT`;
  }
  if (!runtimeColumns.some((column) => column.name === "session_generation")) {
    yield* sql`ALTER TABLE provider_session_runtime ADD COLUMN session_generation TEXT`;
  }
  if (!runtimeColumns.some((column) => column.name === "terminal_disposition")) {
    yield* sql`ALTER TABLE provider_session_runtime ADD COLUMN terminal_disposition TEXT`;
  }

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "default_thread_env_mode")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN default_thread_env_mode TEXT`;
  }
  if (!projectColumns.some((column) => column.name === "favicon_path")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN favicon_path TEXT`;
  }
});
