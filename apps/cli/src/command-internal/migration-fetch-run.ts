import { Effect, FileSystem, Option, Path } from "effect";

import { DnsResolverFlag, resolveYesWithProjectEnv } from "./global-flags.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../shared/output/errors.ts";
import { Output } from "../shared/output/output.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { bold } from "./colors.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import { DbConnection } from "./db-connection.service.ts";
import { loadProjectEnvValues } from "./db-config.read.ts";
import { announcedTarget, hostedMutationPreapproval } from "./hosted-consent/hosted-consent.ts";
import { type MigrationFile, readMigrationTable } from "./migration-history.ts";
import { promptYesNo } from "./prompt-yes-no.ts";
import type { ResolvedTarget } from "./target/resolve-target.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { OperationCanceledError } from "../commands/migration/migration.errors.ts";
import { MigrationFetchWriteError } from "../commands/migration/fetch/fetch.errors.ts";

export interface MigrationFetchInput {
  readonly target: ResolvedTarget;
  /** Overrides `--yes`/`SUPABASE_YES`/`supabase/.env` resolution for the overwrite prompt. */
  readonly assumeYes?: boolean;
}

export interface MigrationFetchOutcome {
  /** Absolute paths written, in remote-history order. */
  readonly files: ReadonlyArray<string>;
}

/** Whether `--yes`, `SUPABASE_YES` or the project's `.env` files answer the overwrite prompt. */
export const resolveOverwriteYes = Effect.fn("MigrationFetch.resolveYes")(function* () {
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* resolveYesWithProjectEnv(
    yield* loadProjectEnvValues(fs, path, cliSettings.workdir),
  );
});

/**
 * Writes the rows `read` yields as `supabase/migrations/<version>_<name>.sql`. A non-empty
 * migrations directory asks before `read` runs, and declining cancels.
 */
export const writeMigrationHistory = Effect.fn("MigrationFetch.write")(function* <E, R>(input: {
  readonly read: Effect.Effect<ReadonlyArray<MigrationFile>, E, R>;
  /** {@link resolveOverwriteYes}, resolved by the caller before its first side effect. */
  readonly yes: boolean;
  /** Answers the overwrite prompt in place of `yes` and the user. */
  readonly assumeYes?: boolean;
}) {
  const { read, yes, assumeYes } = input;
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");

  // Only a missing directory counts as "empty"; any other read error must propagate —
  // collapsing it to empty would skip the confirmation and risk clobbering existing migrations.
  const existing = yield* fs.readDirectory(migrationsDir).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed<ReadonlyArray<string>>([])
        : Effect.fail(
            new MigrationFetchWriteError({
              message: `failed to read migrations: ${cause.message}`,
            }),
          ),
    ),
  );
  if (existing.length > 0) {
    const source = Option.match(yield* announcedTarget, {
      onNone: () => "the target database",
      onSome: bold,
    });
    const title = `Overwrite local migrations with the history from ${source}?`;
    const overwrite =
      assumeYes !== undefined
        ? assumeYes
        : yield* promptYesNo(output, yes, title, true, true, { readMachineStdin: true });
    if (!overwrite) {
      return yield* new OperationCanceledError({ message: CONTEXT_CANCELED_MESSAGE });
    }
  }

  const migrations = yield* read;

  yield* fs
    .makeDirectory(migrationsDir, { recursive: true })
    .pipe(Effect.mapError((cause) => new MigrationFetchWriteError({ message: cause.message })));

  const written: Array<string> = [];
  for (const file of migrations) {
    // The version/name come from the remote `schema_migrations` table. A hostile remote could
    // supply path separators or `..` in either field to escape the migrations dir on write
    // (CWE-22); reject only those traversal vectors so a signed version like `-1` stays
    // writable.
    const escapes = (segment: string) =>
      /[/\\]/u.test(segment) || segment.split(/[/\\]/u).includes("..");
    if (escapes(file.version) || escapes(file.name)) {
      return yield* new MigrationFetchWriteError({
        message: `failed to write migration: invalid version/name in history table: ${file.version}_${file.name}`,
        writtenSoFar: [...written],
      });
    }
    const name = `${file.version}_${file.name}.sql`;
    const filePath = path.join(migrationsDir, name);
    const contents = `${file.statements.join(";\n")};\n`;
    yield* fs.writeFileString(filePath, contents, { mode: 0o644 }).pipe(
      Effect.mapError(
        (cause) =>
          new MigrationFetchWriteError({
            message: `failed to write migration: ${cause.message}`,
            writtenSoFar: [...written],
          }),
      ),
    );
    written.push(filePath);
  }
  yield* Effect.annotateCurrentSpan("migration.count", written.length);

  return { files: written } satisfies MigrationFetchOutcome;
});

export const runMigrationFetch = Effect.fn("MigrationFetch.run")(function* (
  input: MigrationFetchInput,
) {
  const { target, assumeYes } = input;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const dnsResolver = yield* DnsResolverFlag;

  yield* Effect.annotateCurrentSpan("db.conn_type", target.kind);

  // Resolved before any filesystem or prompt side effect so an invalid `--db-url` or
  // `config.toml` fails immediately instead of behind a declined overwrite prompt.
  const cfg = yield* resolver.resolveConnection({
    target,
    dnsResolver,
    password: Option.none(),
    networkBanRemoval: yield* hostedMutationPreapproval,
  });

  const fetchBody = writeMigrationHistory({
    yes: yield* resolveOverwriteYes(),
    read: Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connection.connect(cfg.conn, {
          isLocal: cfg.isLocal,
          dnsResolver,
        });
        return yield* readMigrationTable(session);
      }),
    ),
    ...(assumeYes === undefined ? {} : { assumeYes }),
  });

  // The cache write is attached to the body so a declined prompt returns before it runs.
  if (target.kind !== "linked") return yield* fetchBody;
  const linkedProjectCache = yield* LinkedProjectCache;
  return yield* fetchBody.pipe(Effect.ensuring(linkedProjectCache.cache(target.ref)));
});
