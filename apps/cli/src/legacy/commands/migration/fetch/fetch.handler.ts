import { Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyLoadProjectEnv } from "../../../shared/legacy-db-config.toml-read.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import { legacyReadMigrationTable } from "../../../shared/legacy-migration-history.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacyMigrationTargetFlagsError,
  LegacyOperationCanceledError,
} from "../migration.errors.ts";
import { legacyMigrationConfirm } from "../migration.prompt.ts";
import type { LegacyMigrationFetchFlags } from "./fetch.command.ts";
import { LegacyMigrationFetchWriteError } from "./fetch.errors.ts";

const runFetch = Effect.fnUntraced(function* (
  flags: LegacyMigrationFetchFlags,
  target: ReturnType<typeof resolveLegacyDbTargetFlags>,
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const connection = yield* LegacyDbConnection;
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;

  // Flag-group mutual-exclusion first: cobra's `MarkFlagsMutuallyExclusive` validates at
  // parse time, ahead of the root `PersistentPreRunE` (same ordering as `migration down`/
  // `repair`).
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyMigrationTargetFlagsError({
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
      new LegacyMigrationTargetFlagsError({
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
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliSettings.workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);

  // Linked fetch caches the project ref on success. The ref is
  // loaded now (pre-run), but the cache write is attached to the body via `Effect.ensuring`,
  // so a declined prompt returns before it runs.
  const cacheLinkedRef =
    connType === "linked"
      ? yield* Effect.gen(function* () {
          const projectRef = yield* LegacyProjectRefResolver;
          const linkedProjectCache = yield* LegacyLinkedProjectCache;
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
      .pipe(
        Effect.mapError((cause) => new LegacyMigrationFetchWriteError({ message: cause.message })),
      );
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
              new LegacyMigrationFetchWriteError({
                message: `failed to read migrations: ${cause.message}`,
              }),
            ),
      ),
    );
    if (existing.length > 0) {
      const title = `Do you want to overwrite existing files in ${legacyBold("supabase/migrations")} directory?`;
      const overwrite = yield* legacyMigrationConfirm(title, { defaultValue: true, yes });
      if (!overwrite) {
        return yield* Effect.fail(
          new LegacyOperationCanceledError({ message: CONTEXT_CANCELED_MESSAGE }),
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
        return yield* legacyReadMigrationTable(session);
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
          new LegacyMigrationFetchWriteError({
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
            new LegacyMigrationFetchWriteError({
              message: `failed to write migration: ${cause.message}`,
            }),
        ),
      );
      written.push(filePath);
    }

    // Silent on success in text mode.
    if (output.format !== "text") {
      yield* output.success("Migration history fetched", { files: written });
    }
  });

  return yield* cacheLinkedRef === undefined
    ? fetchBody
    : fetchBody.pipe(Effect.ensuring(cacheLinkedRef));
});

export const legacyMigrationFetch = Effect.fn("legacy.migration.fetch")(function* (
  flags: LegacyMigrationFetchFlags,
) {
  const telemetryState = yield* LegacyTelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  yield* runFetch(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
