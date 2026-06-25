import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import {
  LegacyMigrationApplyError,
  legacyApplyMigrationFile,
} from "../../../shared/legacy-migration-apply.ts";
import {
  legacyFindPendingMigrations,
  legacyListLocalMigrationPaths,
  legacyListRemoteMigrations,
} from "../../../shared/legacy-migration-history.ts";
import { legacyUpsertVaultSecrets } from "../../../shared/legacy-vault.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyMigrationTargetFlagsError } from "../migration.errors.ts";
import type { LegacyMigrationUpFlags } from "./up.command.ts";
import {
  LegacyMigrationMissingLocalError,
  LegacyMigrationMissingRemoteError,
} from "./up.errors.ts";

/** Go's `suggestRevertHistory` (`internal/migration/up/up.go:55`). */
const suggestRevertHistory = (versions: ReadonlyArray<string>): string =>
  "\nMake sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:\n" +
  `${legacyBold(`supabase migration repair --status reverted ${versions.join(" ")}`)}\n` +
  "\nAnd update local migrations to match remote database:\n" +
  `${legacyBold("supabase db pull")}\n`;

/** Go's `suggestIgnoreFlag` (`internal/migration/up/up.go:63`). */
const suggestIgnoreFlag = (paths: ReadonlyArray<string>): string =>
  "\nRerun the command with --include-all flag to apply these migrations:\n" +
  `${legacyBold(paths.join("\n"))}\n`;

const runUp = Effect.fnUntraced(function* (
  flags: LegacyMigrationUpFlags,
  target: ReturnType<typeof resolveLegacyDbTargetFlags>,
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const connection = yield* LegacyDbConnection;
  const cliConfig = yield* LegacyCliConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;

  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyMigrationTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const migrationsDir = path.join(cliConfig.workdir, "supabase", "migrations");

  const upBody = Effect.gen(function* () {
    // up defaults to `--local` (Go: `Bool("local", true)`).
    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType: target.connType ?? "local",
      dnsResolver,
    });
    const ref = Option.getOrUndefined(cfg.ref ?? Option.none());
    const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir, ref);

    yield* Effect.scoped(
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

        const remote = yield* legacyListRemoteMigrations(session);
        const local = yield* legacyListLocalMigrationPaths(fs, path, migrationsDir);
        const result = legacyFindPendingMigrations(local, remote);

        let pending: ReadonlyArray<string>;
        if (result.kind === "missing-local") {
          return yield* Effect.fail(
            new LegacyMigrationMissingLocalError({
              message: "Remote migration versions not found in local migrations directory.",
              suggestion: suggestRevertHistory(result.versions),
            }),
          );
        } else if (result.kind === "missing-remote") {
          if (!flags.includeAll) {
            return yield* Effect.fail(
              new LegacyMigrationMissingRemoteError({
                message:
                  "Found local migration files to be inserted before the last migration on remote database.",
                suggestion: suggestIgnoreFlag(result.paths),
              }),
            );
          }
          // Go's `--include-all`: the out-of-order set + everything after the
          // applied prefix (`up.go:47`).
          pending = [...result.paths, ...local.slice(remote.length + result.paths.length)];
        } else {
          pending = result.paths;
        }

        yield* legacyUpsertVaultSecrets(session, toml.vault);

        for (const migrationPath of pending) {
          yield* output.raw(`Applying migration ${path.basename(migrationPath)}...\n`, "stderr");
          yield* legacyApplyMigrationFile(
            session,
            fs,
            path,
            migrationPath,
            (message) => new LegacyMigrationApplyError({ message }),
          );
        }

        if (output.format === "text") {
          yield* output.raw("Local database is up to date.\n");
        } else {
          yield* output.success("Migrations applied", { applied: pending });
        }
      }),
    );
  });

  if ((target.connType ?? "local") === "linked") {
    const projectRef = yield* LegacyProjectRefResolver;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;
    const linkedRef = yield* projectRef.loadProjectRef(Option.none());
    return yield* upBody.pipe(Effect.ensuring(linkedProjectCache.cache(linkedRef)));
  }
  return yield* upBody;
});

export const legacyMigrationUp = Effect.fn("legacy.migration.up")(function* (
  flags: LegacyMigrationUpFlags,
) {
  const telemetryState = yield* LegacyTelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  yield* runUp(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
