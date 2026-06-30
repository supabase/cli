import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyDnsResolverFlag, legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
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
  const cliConfig = yield* LegacyCliConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const yes = yield* legacyResolveYes; // --yes OR SUPABASE_YES (Go viper AutomaticEnv, root.go:318-334).

  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyMigrationTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const connType = target.connType ?? "linked"; // fetch defaults to `--linked` (Go: `Bool("linked", true)`).

  // Resolve the DB config BEFORE any filesystem/prompt side effects — mirroring Go's
  // root `PersistentPreRunE` (`apps/cli-go/cmd/root.go:118`), which parses the DB config
  // before `migrationFetchCmd.RunE` calls `fetch.Run`. An invalid `--db-url`/`config.toml`
  // then fails immediately, instead of first creating `supabase/migrations` or letting a
  // declined overwrite prompt mask the real error with `context canceled`. Same fix as
  // `migration repair`.
  const cfg = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    connType,
    dnsResolver,
  });

  // Linked fetch caches the project ref on success (Go's `PersistentPostRun`). The ref is
  // loaded now (pre-run), but the cache write is attached to the body via `Effect.ensuring`,
  // so a declined prompt returns before it runs — matching Go (PostRun is skipped on a
  // non-nil RunE error).
  const cacheLinkedRef =
    connType === "linked"
      ? yield* Effect.gen(function* () {
          const projectRef = yield* LegacyProjectRefResolver;
          const linkedProjectCache = yield* LegacyLinkedProjectCache;
          const ref = yield* projectRef.loadProjectRef(Option.none());
          return linkedProjectCache.cache(ref);
        })
      : undefined;

  const fetchBody = Effect.gen(function* () {
    const migrationsDir = path.join(cliConfig.workdir, "supabase", "migrations");

    // Go: `MkdirIfNotExistFS` then `afero.IsEmpty`; prompt before overwriting a
    // non-empty migrations dir (default YES). Cancel → `context.Canceled`.
    yield* fs
      .makeDirectory(migrationsDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) => new LegacyMigrationFetchWriteError({ message: cause.message })),
      );
    // Go's `fetch.Run` gates the overwrite prompt on `afero.IsEmpty`, which aborts on
    // ANY read failure before fetching/writing (`internal/migration/fetch/fetch.go:21-22`).
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
          new LegacyOperationCanceledError({ message: "context canceled" }),
        );
      }
    }

    const migrations = yield* Effect.scoped(
      Effect.gen(function* () {
        // Go's `utils.ConnectByConfig` prints this to stderr before dialing
        // (`internal/utils/connect.go:343-348`), local/remote per `IsLocalDatabase`.
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
      // escape the migrations dir on write (CWE-22). Go writes the raw column values
      // verbatim (`fmt.Sprintf("%s_%s.sql", r.Version, r.Name)`,
      // `internal/migration/fetch/fetch.go:36`) with no digit check, so reject only the
      // actual traversal vectors — separators and `..` segments — in both fields. This
      // keeps a Go-valid signed version like `-1` writable while closing the vector.
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
      // Go: `strings.Join(statements, ";\n") + ";\n"`.
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

    // Go is silent on success in text mode.
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
