import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector } from "../database/database-target.ts";
import { formatNextAction } from "../schema/schema-output.ts";
import type { SchemaScriptFile } from "../schema/schema-body.ts";
import { SchemaEmptyMigrationStatementsError } from "../schema/schema-errors.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import {
  formatMigrationRepairCommand,
  formatMigrationsDiffFileCommand,
  formatMigrationsPushCommand,
  repairFlagsForTarget,
} from "./migration-repair-suggest.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

export type PullMigrationsInput = {
  readonly from?: string;
};

export function formatFetchedMigrationSql(statements: ReadonlyArray<string>): string {
  return `${statements.join(";\n")};\n`;
}

export const pullMigrations = Effect.fn("migrations.pull")(function* (input: PullMigrationsInput) {
  const targets = yield* DatabaseTargetResolver;
  const repository = yield* MigrationRepository;
  const runner = yield* MigrationRunner;
  const remote = yield* targets.resolve(parseTargetSelector(input.from ?? "linked"));
  const flags = repairFlagsForTarget(remote);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const remotePool = yield* acquireDatabasePool(remote.connectionString);
      const history = yield* runner.listRemoteStatements(remotePool);
      if (history.length === 0) {
        return {
          status: "clean",
          message: "Nothing to fetch.",
          data: {
            status: "clean",
            fetched: [],
            skipped: [],
            conflicts: [],
            files: [],
            mutated_files: false,
            mutated_database: false,
          },
          nextActions: [],
          mutatedDatabase: false,
          mutatedFiles: false,
        } satisfies SchemaCommandResult;
      }

      const fetched: Array<string> = [];
      const skipped: Array<string> = [];
      const conflicts: Array<{ readonly version: string; readonly remoteCopy: string }> = [];
      const files: Array<SchemaScriptFile> = [];
      const messages: Array<string> = [];
      const localBefore = yield* repository.listLocal;
      const localByVersion = new Map(localBefore.map((file) => [file.version, file]));
      const emptyRemoteOnly = history.filter(
        (row) => row.statements.length === 0 && !localByVersion.has(row.version),
      );
      if (emptyRemoteOnly[0] !== undefined) {
        const row = emptyRemoteOnly[0];
        return yield* new SchemaEmptyMigrationStatementsError({
          detail: `Remote history row ${row.version} (${row.name}) has no statements.`,
          suggestion: `${formatMigrationsDiffFileCommand(flags)} then ${formatMigrationRepairCommand(
            {
              status: "applied",
              versions: [row.version],
              flags,
            },
          )}. Or restore the file from git.`,
        });
      }

      for (const row of history) {
        if (row.statements.length === 0) {
          const existing = localByVersion.get(row.version);
          if (existing !== undefined) {
            skipped.push(existing.fileName);
            files.push({
              name: existing.fileName,
              version: row.version,
              status: "skipped",
            });
          }
          continue;
        }
        const sql = formatFetchedMigrationSql(row.statements);
        const result = yield* repository.writeFetched({
          version: row.version,
          name: row.name,
          sql,
        });
        if (result.outcome === "written") {
          fetched.push(result.file.fileName);
          files.push({ name: result.file.fileName, version: row.version, status: "fetched" });
        } else if (result.outcome === "skipped") {
          skipped.push(result.file.fileName);
          files.push({ name: result.file.fileName, version: row.version, status: "skipped" });
        } else {
          conflicts.push({
            version: row.version,
            remoteCopy: result.remoteCopyDisplay,
          });
          files.push({ name: result.file.fileName, version: row.version, status: "conflict" });
          messages.push(
            `Left local ${result.file.fileName}; wrote remote bytes to ${result.remoteCopyDisplay}. statements[] join can differ in formatting.`,
          );
        }
      }

      const local = yield* repository.listLocal;
      const remoteVersions = new Set(history.map((row) => row.version));
      const pending = local.filter((file) => !remoteVersions.has(file.version));
      if (pending.length > 0) {
        messages.push(
          `Local pending remain (${pending.map((file) => file.version).join(", ")}). Pull does not merge them.`,
        );
      }

      const mutatedFiles = fetched.length > 0 || conflicts.length > 0;
      const headline =
        fetched.length === 0 && conflicts.length === 0
          ? "Remote history already matches local files."
          : fetched.length > 0
            ? `Fetched ${fetched.length} migration(s).`
            : "Remote history differs from local files.";

      return {
        status: conflicts.length > 0 ? "conflict" : mutatedFiles ? "generated" : "clean",
        message: [headline, ...messages].join("\n"),
        data: {
          status: conflicts.length > 0 ? "conflict" : mutatedFiles ? "generated" : "clean",
          fetched,
          skipped,
          conflicts,
          files,
          pending: pending.map((file) => file.version),
          mutated_files: mutatedFiles,
          mutated_database: false,
        },
        nextActions:
          pending.length > 0
            ? [
                formatNextAction(
                  remote.kind === "local"
                    ? "to apply your pending files"
                    : "to deploy your pending files",
                  formatMigrationsPushCommand(flags),
                ),
              ]
            : [],
        mutatedDatabase: false,
        mutatedFiles,
      } satisfies SchemaCommandResult;
    }),
  );
});
