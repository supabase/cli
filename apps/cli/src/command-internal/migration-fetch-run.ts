import { Effect, FileSystem, Option, Path } from "effect";

import { DnsResolverFlag, resolveYesWithProjectEnv } from "./global-flags.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../shared/output/errors.ts";
import { Output } from "../shared/output/output.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { ProjectRefResolver } from "../config/project-ref.service.ts";
import { bold } from "./colors.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import { DbConnection } from "./db-connection.service.ts";
import { loadProjectEnv } from "./db-config.toml-read.ts";
import { type DbTargetSelection } from "./db-target-flags.ts";
import { readMigrationTable } from "./migration-history.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import {
  MigrationTargetFlagsError,
  OperationCanceledError,
} from "../commands/migration/migration.errors.ts";
import { migrationConfirm } from "../commands/migration/migration.prompt.ts";
import type { MigrationFetchFlags } from "../commands/migration/fetch/fetch.command.ts";
import { MigrationFetchWriteError } from "../commands/migration/fetch/fetch.errors.ts";

// Re-exported so an in-process caller (`pull`) can build a `MigrationFetchInput` without
// reaching into `commands/migration/**` directly.
export type { MigrationFetchFlags };

export interface MigrationFetchInput {
  readonly flags: MigrationFetchFlags;
  readonly target: DbTargetSelection;
  /** Overrides `--yes`/`SUPABASE_YES`/`supabase/.env` resolution. */
  readonly assumeYes?: boolean;
}

export interface MigrationFetchOutcome {
  /** Absolute paths written, in remote-history order. */
  readonly files: ReadonlyArray<string>;
}

export const runMigrationFetch = Effect.fnUntraced(function* (input: MigrationFetchInput) {
  const { flags, target, assumeYes } = input;
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;

  // Validated first, before any other work — same ordering as `migration down`/`repair`.
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new MigrationTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const connType = target.connType ?? "linked"; // fetch defaults to `--linked`.

  // `--project-ref` never implies `--linked` and must not be silently
  // discarded on a non-linked target — see push.handler.ts's identical guard
  // (db push) for the full TS-only rationale.
  if (Option.isSome(flags.projectRef) && connType !== "linked") {
    return yield* Effect.fail(
      new MigrationTargetFlagsError({
        message:
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      }),
    );
  }

  // Resolve the DB config BEFORE any filesystem/prompt side effects — an invalid
  // `--db-url`/`config.toml` then fails immediately, instead of first creating
  // `supabase/migrations` or letting a declined overwrite prompt mask the real error
  // with `context canceled`. Same fix as `migration repair`.
  const cfg = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    connType,
    dnsResolver,
    linkedProjectRef: flags.projectRef,
  });

  // The project .env loads after the parse-time flag-group validation above — so a
  // SUPABASE_YES set only in supabase/.env auto-confirms, but a flag conflict still
  // surfaces before any .env read. Resolve --yes against the project env here, not
  // just process.env. Same ordering as `migration down`/`repair`.
  const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);

  // Linked fetch caches the project ref on success. The ref is
  // loaded now (pre-run), but the cache write is attached to the body via `Effect.ensuring`,
  // so a declined prompt returns before it runs.
  const cacheLinkedRef =
    connType === "linked"
      ? yield* Effect.gen(function* () {
          const projectRef = yield* ProjectRefResolver;
          const linkedProjectCache = yield* LinkedProjectCache;
          const ref = yield* projectRef.loadProjectRef(flags.projectRef);
          return linkedProjectCache.cache(ref);
        })
      : undefined;

  const fetchBody = Effect.gen(function* () {
    const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");

    yield* fs
      .makeDirectory(migrationsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new MigrationFetchWriteError({ message: cause.message })));
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
      const title = `Do you want to overwrite existing files in ${bold("supabase/migrations")} directory?`;
      const overwrite =
        assumeYes !== undefined
          ? assumeYes
          : yield* migrationConfirm(title, { defaultValue: true, yes });
      if (!overwrite) {
        return yield* Effect.fail(
          new OperationCanceledError({ message: CONTEXT_CANCELED_MESSAGE }),
        );
      }
    }

    const migrations = yield* Effect.scoped(
      Effect.gen(function* () {
        // The connect diagnostic prints to stderr before dialing,
        // local/remote per the resolved connection.
        yield* output.raw(
          `Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`,
          "stderr",
        );
        const session = yield* connection.connect(cfg.conn, {
          isLocal: cfg.isLocal,
          dnsResolver,
        });
        return yield* readMigrationTable(session);
      }),
    );

    const written: Array<string> = [];
    for (const file of migrations) {
      // The version/name come from the remote `schema_migrations` table. A hostile remote could
      // supply path separators or `..` in either field to escape the migrations dir on write
      // (CWE-22); reject only those traversal vectors so a signed version like `-1` stays
      // writable.
      const escapes = (segment: string) =>
        /[/\\]/u.test(segment) || segment.split(/[/\\]/u).includes("..");
      if (escapes(file.version) || escapes(file.name)) {
        return yield* Effect.fail(
          new MigrationFetchWriteError({
            message: `failed to write migration: invalid version/name in history table: ${file.version}_${file.name}`,
            writtenSoFar: [...written],
          }),
        );
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

    return { files: written } satisfies MigrationFetchOutcome;
  });

  return yield* cacheLinkedRef === undefined
    ? fetchBody
    : fetchBody.pipe(Effect.ensuring(cacheLinkedRef));
});
