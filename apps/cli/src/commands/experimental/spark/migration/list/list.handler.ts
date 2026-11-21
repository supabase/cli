import { Effect } from "effect";

import { sortMigrationVersions } from "../../../../../command-internal/migration-timestamp.format.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { renderGlamourTable } from "../../../../../output/glamour-table.ts";
import {
  makeMigrationListRows,
  migrationListTableCells,
} from "../../../../../command-internal/migration-list.format.ts";
import type { TargetFlagValues } from "../../../../../command-internal/target/target-flags.ts";
import { localMigrations, projectPaths } from "../../spark.shared.ts";
import { SparkTarget, withSparkTarget } from "../../spark-target.ts";

/** `supabase migration list`: local migration files against the project's migration history. */
export const sparkMigrationList = Effect.fn("spark.migration.list")(function* (
  flags: TargetFlagValues,
) {
  yield* withSparkTarget(flags, () =>
    Effect.gen(function* () {
      const spark = yield* SparkTarget;
      const output = yield* Output;
      const paths = yield* projectPaths();
      const local = (yield* localMigrations(paths.migrations)).map((m) => m.version);
      const remote = sortMigrationVersions((yield* spark.listMigrations).map((m) => m.version));
      const rows = makeMigrationListRows(remote, local);
      if (output.format === "json" || output.format === "stream-json")
        return yield* output.success("", { migrations: rows });
      yield* output.raw(
        renderGlamourTable(["Local", "Remote", "Time (UTC)"], migrationListTableCells(rows)),
      );
    }),
  );
});
