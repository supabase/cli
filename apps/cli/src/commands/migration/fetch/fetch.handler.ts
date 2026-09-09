import { Effect, FileSystem, Option, Path } from "effect";

import {
  DnsResolverFlag,
  resolveYesWithProjectEnv,
} from "../../../command-internal/global-flags.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../shared/output/errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { loadProjectEnv } from "../../../command-internal/db-config.toml-read.ts";
import {
  resolveDbTargetFlags,
  type DbTargetSelection,
} from "../../../command-internal/db-target-flags.ts";
import { readMigrationTable } from "../../../command-internal/migration-history.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { MigrationTargetFlagsError, OperationCanceledError } from "../migration.errors.ts";
import { migrationConfirm } from "../migration.prompt.ts";
import type { MigrationFetchFlags } from "./fetch.command.ts";
import { MigrationFetchWriteError } from "./fetch.errors.ts";

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

  // Flag-group mutual-exclusion first: cobra's `MarkFlagsMutuallyExclusive` validates at
  // parse time, ahead of the root `PersistentPreRunE` (same ordering as `migration down`/
  // `repair`).
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

    // Create the migrations dir if missing, then prompt before overwriting a
    // non-empty migrations dir (default YES). Cancel → cancellation.
    yield* fs
      .makeDirectory(migrationsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new MigrationFetchWriteError({ message: cause.message })));
    // The overwrite prompt is gated on directory emptiness, which aborts on
    // ANY read failure before fetching/writing.
    // Only a missing directory counts as "empty"; a read error (e.g. an unreadable dir)
    // must propagate — collapsing it to empty would skip the confirmation and clobber
    // existing migrations.
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
      // The version/name come from the remote `schema_migrations` table. A
      // tampered/hostile remote could supply path separators or `..` in EITHER field to
      // escape the migrations dir on write (CWE-22). The raw column values write
      // verbatim, with no digit check, so reject only the
      // actual traversal vectors — separators and `..` segments — in both fields. This
      // keeps a signed version like `-1` writable while closing the vector.
      const escapes = (segment: string) =>
        /[/\\]/u.test(segment) || segment.split(/[/\\]/u).includes("..");
      if (escapes(file.version) || escapes(file.name)) {
        return yield* Effect.fail(
          new MigrationFetchWriteError({
            message: `failed to write migration: invalid version/name in history table: ${file.version}_${file.name}`,
          }),
        );
      }
      const name = `${file.version}_${file.name}.sql`;
      const filePath = path.join(migrationsDir, name);
      // The written form joins statements with `;\n`, plus a trailing `;\n`.
      const contents = `${file.statements.join(";\n")};\n`;
      yield* fs.writeFileString(filePath, contents, { mode: 0o644 }).pipe(
        Effect.mapError(
          (cause) =>
            new MigrationFetchWriteError({
              message: `failed to write migration: ${cause.message}`,
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

export const migrationFetch = Effect.fn("migration.fetch")(function* (flags: MigrationFetchFlags) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveDbTargetFlags(cliArgs.args);
  const outcome = yield* runMigrationFetch({ flags, target, assumeYes: undefined }).pipe(
    Effect.ensuring(telemetryState.flush),
  );

  // Silent on success in text mode.
  if (output.format !== "text") {
    yield* output.success("Migration history fetched", { files: outcome.files });
  }
});
