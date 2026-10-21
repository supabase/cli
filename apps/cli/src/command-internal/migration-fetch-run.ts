import { Effect, FileSystem, Option, Path } from "effect";

import { DnsResolverFlag, resolveYesWithProjectEnv } from "./global-flags.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../shared/output/errors.ts";
import { Output } from "../shared/output/output.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { bold } from "./colors.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import { DbConnection } from "./db-connection.service.ts";
import { loadProjectEnvValues } from "./db-config.toml-read.ts";
import { announcedTarget, hostedMutationPreapproval } from "./hosted-consent/hosted-consent.ts";
import { readMigrationTable } from "./migration-history.ts";
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

export const runMigrationFetch = Effect.fn("MigrationFetch.run")(function* (
  input: MigrationFetchInput,
) {
  const { target, assumeYes } = input;
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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

  const projectEnv = yield* loadProjectEnvValues(fs, path, cliSettings.workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);

  // The cache write is attached to the body so a declined prompt returns before it runs.
  let cacheLinkedRef: Effect.Effect<void> | undefined;
  if (target.kind === "linked") {
    const linkedProjectCache = yield* LinkedProjectCache;
    cacheLinkedRef = linkedProjectCache.cache(target.ref);
  }

  const fetchBody = Effect.gen(function* () {
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

    const migrations = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connection.connect(cfg.conn, {
          isLocal: cfg.isLocal,
          dnsResolver,
        });
        return yield* readMigrationTable(session);
      }),
    );

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

  return yield* cacheLinkedRef === undefined
    ? fetchBody
    : fetchBody.pipe(Effect.ensuring(cacheLinkedRef));
});
