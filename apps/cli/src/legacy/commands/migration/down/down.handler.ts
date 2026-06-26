import { Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua, legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import {
  legacyLoadProjectEnv,
  legacyReadDbToml,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import { legacyDropUserSchemas } from "../../../shared/legacy-drop-objects.ts";
import { legacyMigrateAndSeed } from "../../../shared/legacy-migrate-and-seed.ts";
import { legacyListRemoteMigrations } from "../../../shared/legacy-migration-history.ts";
import { legacyUpsertVaultSecrets } from "../../../shared/legacy-vault.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacyMigrationTargetFlagsError,
  LegacyOperationCanceledError,
} from "../migration.errors.ts";
import { legacyMigrationConfirm } from "../migration.prompt.ts";
import type { LegacyMigrationDownFlags } from "./down.command.ts";
import { LegacyMigrationLastTooLargeError, LegacyMigrationLastZeroError } from "./down.errors.ts";

/** Go's `confirmResetAll` (`internal/migration/down/down.go:64`). */
const confirmResetAll = (pending: ReadonlyArray<string>): string => {
  let title = "Do you want to revert the following migrations?\n";
  for (const version of pending) title += ` • ${legacyBold(version)}\n`;
  title += `${legacyYellow("WARNING:")} you will lose all data in this database.`;
  return title;
};

const runDown = Effect.fnUntraced(function* (
  flags: LegacyMigrationDownFlags,
  target: ReturnType<typeof resolveLegacyDbTargetFlags>,
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const connection = yield* LegacyDbConnection;
  const cliConfig = yield* LegacyCliConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;

  // Flag-group mutual-exclusion first: cobra's `MarkFlagsMutuallyExclusive` validates at
  // parse time, ahead of the root `PersistentPreRunE` (`cmd/migration.go:156`).
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyMigrationTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const connType = target.connType ?? "local"; // down defaults to `--local` (Go: `Bool("local", true)`).

  // Resolve the DB config BEFORE the `--last` validation — Go's root `PersistentPreRunE`
  // runs `ParseDatabaseConfig` (`cmd/root.go:118`) before `down.Run`'s `last == 0` check
  // (`internal/migration/down/down.go:20-23`), so an unlinked/invalid target surfaces
  // before the `--last must be greater than 0` error.
  const cfg = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    connType,
    dnsResolver,
  });

  // Go loads the project .env via loadNestedEnv INSIDE ParseDatabaseConfig (config.go:701),
  // i.e. after the parse-time flag-group validation above — so a SUPABASE_YES set only in
  // supabase/.env auto-confirms, but a flag conflict still surfaces before any .env read.
  // Resolve --yes against the project env here, not just process.env (root.go:318-334).
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);

  // Linked down caches the project ref (Go's `ensureProjectGroupsCached` from `Execute()`,
  // gated on the ref loaded in pre-run, NOT on the RunE error). Load it now and attach the
  // cache to the whole flow via `Effect.ensuring`, so it runs even on the `--last`/cancel
  // failure paths.
  const cacheLinkedRef =
    connType === "linked"
      ? yield* Effect.gen(function* () {
          const projectRef = yield* LegacyProjectRefResolver;
          const linkedProjectCache = yield* LegacyLinkedProjectCache;
          const linkedRef = yield* projectRef.loadProjectRef(Option.none());
          return linkedProjectCache.cache(linkedRef);
        })
      : undefined;

  const downFlow = Effect.gen(function* () {
    // `--last` zero-value validation runs after DB-config resolution (Go's check is inside
    // `down.Run`, after `PersistentPreRunE`).
    if (flags.last === 0) {
      return yield* Effect.fail(
        new LegacyMigrationLastZeroError({ message: "--last must be greater than 0" }),
      );
    }

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
        const total = remote.length;
        if (total <= flags.last) {
          return yield* Effect.fail(
            new LegacyMigrationLastTooLargeError({
              message: `--last must be smaller than total applied migrations: ${total}`,
              suggestion: `Try ${legacyAqua("supabase db reset")} if you want to revert all migrations.`,
            }),
          );
        }

        const confirmed = yield* legacyMigrationConfirm(
          confirmResetAll(remote.slice(total - flags.last)),
          {
            defaultValue: false,
            yes,
          },
        );
        if (!confirmed) {
          return yield* Effect.fail(
            new LegacyOperationCanceledError({ message: "context canceled" }),
          );
        }

        const version = remote[total - flags.last - 1]!;
        yield* output.raw(`Resetting database to version: ${version}\n`, "stderr");
        yield* legacyDropUserSchemas(session);
        yield* legacyUpsertVaultSecrets(session, toml.vault);
        yield* legacyMigrateAndSeed(session, fs, path, cliConfig.workdir, version, {
          migrationsEnabled: toml.migrationsEnabled,
          seed: toml.seed,
        });

        if (output.format !== "text") {
          yield* output.success("Migrations reverted", { version, last: flags.last });
        }
      }),
    );
  });

  return yield* cacheLinkedRef === undefined
    ? downFlow
    : downFlow.pipe(Effect.ensuring(cacheLinkedRef));
});

export const legacyMigrationDown = Effect.fn("legacy.migration.down")(function* (
  flags: LegacyMigrationDownFlags,
) {
  const telemetryState = yield* LegacyTelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  yield* runDown(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
