import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector, type DatabaseTarget } from "../database/database-target.ts";
import {
  formatMigrationInventory,
  humanTarget,
  type MigrationInventoryStatus,
} from "../schema/schema-body.ts";
import { formatNextAction } from "../schema/schema-output.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import {
  formatMigrationsPullCommand,
  formatMigrationsPushCommand,
  formatSchemaPullCommand,
  repairFlagsForTarget,
} from "./migration-repair-suggest.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";
import { warnIfRemotePostgresMajorMismatch } from "./remote-postgres.ts";

export type ListMigrationsInput = {
  readonly against?: string;
};

type ListHistory = "matched" | "pending" | "remote_only" | "conflict";

type ListRow = {
  readonly version: string;
  readonly name: string;
  readonly local: boolean;
  readonly remote: boolean;
};

function rowStatus(row: ListRow): MigrationInventoryStatus {
  if (row.local && row.remote) return "applied";
  if (row.local) return "pending";
  return "remote-only";
}

function historyAlignment(pending: number, remoteOnly: number): ListHistory {
  if (pending > 0 && remoteOnly > 0) return "conflict";
  if (pending > 0) return "pending";
  if (remoteOnly > 0) return "remote_only";
  return "matched";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function listVerdict(input: {
  readonly target: DatabaseTarget;
  readonly total: number;
  readonly applied: number;
  readonly pending: number;
  readonly remoteOnly: number;
  readonly history: ListHistory;
}): string {
  const where = humanTarget(input.target);
  if (input.total === 0) {
    return `No migrations on ${where}.`;
  }
  switch (input.history) {
    case "matched":
      return `${plural(input.applied, "migration")} applied on ${where}. History matches files.`;
    case "pending":
      return `${input.pending} of ${input.total} ${input.total === 1 ? "migration" : "migrations"} pending on ${where}.`;
    case "remote_only":
      return `${plural(input.remoteOnly, "remote-only migration")} on ${where} (no local file).`;
    case "conflict":
      return `${plural(input.pending, "pending migration")} and ${plural(input.remoteOnly, "remote-only migration")} on ${where}.`;
  }
}

function listNextActions(input: {
  readonly target: DatabaseTarget;
  readonly history: ListHistory;
}): ReadonlyArray<string> {
  switch (input.history) {
    case "matched":
      return [];
    case "pending":
      return [
        input.target.kind === "local"
          ? formatNextAction("to apply it locally", "supabase migrations apply")
          : formatNextAction(
              "to deploy",
              formatMigrationsPushCommand(repairFlagsForTarget(input.target)),
            ),
      ];
    case "remote_only":
    case "conflict":
      return [
        formatNextAction(
          "to fetch missing files",
          formatMigrationsPullCommand(repairFlagsForTarget(input.target)),
        ),
        formatNextAction(
          "to refresh declarations",
          formatSchemaPullCommand(repairFlagsForTarget(input.target)),
        ),
      ];
  }
}

export const listMigrations = Effect.fn("migrations.list")(function* (input: ListMigrationsInput) {
  const repository = yield* MigrationRepository;
  const runner = yield* MigrationRunner;
  const targets = yield* DatabaseTargetResolver;
  const local = yield* repository.listLocal;
  const selector = parseTargetSelector(input.against ?? "local");
  const target = yield* targets.resolve(selector);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* acquireDatabasePool(target.connectionString);
      yield* warnIfRemotePostgresMajorMismatch(pool, target);
      const remote = yield* runner.listRemote(pool);
      const remoteVersions = new Set(remote.map((row) => row.version));
      const localVersions = new Set(local.map((file) => file.version));
      const rows: ListRow[] = [
        ...local.map((file) => ({
          version: file.version,
          name: file.name,
          local: true,
          remote: remoteVersions.has(file.version),
        })),
        ...remote
          .filter((row) => !localVersions.has(row.version))
          .map((row) => ({
            version: row.version,
            name: row.name,
            local: false,
            remote: true,
          })),
      ].sort((left, right) => left.version.localeCompare(right.version));

      const applied = rows.filter((row) => row.local && row.remote).length;
      const pending = rows.filter((row) => row.local && !row.remote).length;
      const remoteOnly = rows.filter((row) => !row.local && row.remote).length;
      const history = historyAlignment(pending, remoteOnly);
      const body = formatMigrationInventory(
        rows.map((row) => ({
          version: row.version,
          name: row.name,
          status: rowStatus(row),
        })),
      );

      return {
        status: "clean",
        message: listVerdict({
          target,
          total: rows.length,
          applied,
          pending,
          remoteOnly,
          history,
        }),
        ...(body.length > 0 ? { body } : {}),
        data: {
          status: "clean",
          target: target.identity,
          migrations: rows,
          files: rows.map((row) => ({
            name: row.name,
            version: row.version,
            status: rowStatus(row),
          })),
          applied,
          pending,
          remote_only: remoteOnly,
          history,
          mutated_database: false,
          mutated_files: false,
        },
        nextActions: listNextActions({ target, history }),
        mutatedDatabase: false,
        mutatedFiles: false,
      } satisfies SchemaCommandResult;
    }),
  );
});
