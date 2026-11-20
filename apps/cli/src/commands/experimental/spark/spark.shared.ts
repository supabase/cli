import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { MIGRATE_FILE_PATTERN } from "../../../command-internal/migration-history.ts";
import { sortMigrationVersions } from "../../../command-internal/migration-timestamp.format.ts";
import type { SparkDryRunStatus } from "./spark-api.ts";

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

/** Resolves the linked project and caches it for telemetry whether `body` succeeds or fails. */
export const withLinkedProject = <A, E, R>(
  projectRef: Option.Option<string>,
  body: (ref: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const resolver = yield* ProjectRefResolver;
    const linkedProjectCache = yield* LinkedProjectCache;
    const telemetryState = yield* TelemetryState;
    const ref = yield* resolver.resolve(projectRef);
    return yield* body(ref).pipe(
      Effect.ensuring(linkedProjectCache.cache(ref)),
      Effect.ensuring(telemetryState.flush),
    );
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
