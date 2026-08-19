import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector } from "../database/database-target.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

export type ListMigrationsInput = {
  readonly against?: string;
};

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
      const remote = yield* runner.listRemote(pool);
      const remoteVersions = new Set(remote.map((row) => row.version));
      const localVersions = new Set(local.map((file) => file.version));
      const rows = [
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

      return {
        status: "clean",
        message: `Compared ${rows.length} migration(s) against ${target.identity}.`,
        data: {
          status: "clean",
          target: target.identity,
          migrations: rows,
          mutated_database: false,
          mutated_files: false,
        },
        nextActions: [],
        mutatedDatabase: false,
        mutatedFiles: false,
      } satisfies SchemaCommandResult;
    }),
  );
});
