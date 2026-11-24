import type { SparkDryRunStatus } from "@supabase/stack/spark";
import { Effect, FileSystem, Path } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { MIGRATE_FILE_PATTERN } from "../../../command-internal/migration-history.ts";
import { sortMigrationVersions } from "../../../command-internal/migration-timestamp.format.ts";

export const projectPaths = Effect.fn("Spark.projectPaths")(function* () {
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const root = path.resolve(settings.workdir);
  return {
    root,
    migrations: path.join(root, "supabase", "migrations"),
    schemas: path.join(root, "supabase", "schemas"),
  };
});

export const reportRefusals = Effect.fnUntraced(function* (
  label: string,
  refused: ReadonlyArray<{ readonly status: SparkDryRunStatus; readonly at: string | undefined }>,
) {
  const output = yield* Output;
  yield* output.raw(
    `Spark refuses ${refused.length} statement(s) of ${label}. Each one is a Postgres compatibility gap of Spark:\n`,
    "stderr",
  );
  for (const { status, at } of refused) {
    const line = status.line === undefined || status.line === null ? "" : ` (line ${status.line})`;
    if (at !== undefined) yield* output.raw(`  ${at}\n`, "stderr");
    yield* output.raw(
      `  ${status.status} ${status.kind}${line}: ${status.statement}\n${
        status.message === undefined || status.message === null ? "" : `    ${status.message}\n`
      }`,
      "stderr",
    );
  }
});

/** Local migration files in version order. */
export const localMigrations = Effect.fn("Spark.localMigrations")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(directory))) return [];
  const found = (yield* fs.readDirectory(directory)).flatMap((file) => {
    const match = MIGRATE_FILE_PATTERN.exec(file);
    return match?.[1] === undefined ? [] : [{ file, version: match[1], name: match[2] ?? "" }];
  });
  const order = sortMigrationVersions(found.map((m) => m.version));
  return order.flatMap((version) => found.filter((m) => m.version === version));
});
