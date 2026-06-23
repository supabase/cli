import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyDnsResolverFlag, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua, legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
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
  const yes = yield* LegacyYesFlag;

  if (flags.last === 0) {
    return yield* Effect.fail(
      new LegacyMigrationLastZeroError({ message: "--last must be greater than 0" }),
    );
  }
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyMigrationTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const downBody = Effect.gen(function* () {
    // down defaults to `--local` (Go: `Bool("local", true)`).
    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType: target.connType ?? "local",
      dnsResolver,
    });
    const ref = Option.getOrUndefined(cfg.ref ?? Option.none());
    const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir, ref);

    yield* Effect.scoped(
      Effect.gen(function* () {
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

  if ((target.connType ?? "local") === "linked") {
    const projectRef = yield* LegacyProjectRefResolver;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;
    const linkedRef = yield* projectRef.loadProjectRef(Option.none());
    return yield* downBody.pipe(Effect.ensuring(linkedProjectCache.cache(linkedRef)));
  }
  return yield* downBody;
});

export const legacyMigrationDown = Effect.fn("legacy.migration.down")(function* (
  flags: LegacyMigrationDownFlags,
) {
  const telemetryState = yield* LegacyTelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  yield* runDown(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
