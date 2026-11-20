import { Effect, Option } from "effect";

import { sortMigrationVersions } from "../../../../../command-internal/migration-timestamp.format.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { renderGlamourTable } from "../../../../../output/glamour-table.ts";
import {
  makeMigrationListRows,
  migrationListTableCells,
} from "../../../../../command-internal/migration-list.format.ts";
import { listSparkMigrations } from "../../spark-api.ts";
import { localMigrations, projectPaths, withLinkedProject } from "../../spark.shared.ts";

/** `supabase migration list`: local migration files against the project's migration history. */
export const sparkMigrationList = Effect.fn("spark.migration.list")(function* (flags: {
  readonly projectRef: Option.Option<string>;
}) {
  yield* withLinkedProject(flags.projectRef, (ref) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const paths = yield* projectPaths();
      const local = (yield* localMigrations(paths.migrations)).map((m) => m.version);
      const remote = sortMigrationVersions((yield* listSparkMigrations(ref)).map((m) => m.version));
      const rows = makeMigrationListRows(remote, local);
      if (output.format === "json" || output.format === "stream-json")
        return yield* output.success("", { migrations: rows });
      yield* output.raw(
        renderGlamourTable(["Local", "Remote", "Time (UTC)"], migrationListTableCells(rows)),
      );
    }),
  );
});
