import { Effect, FileSystem, Option, Path } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { aqua, bold, yellow } from "../../../command-internal/colors.ts";
import { readDbToml } from "../../../command-internal/db-config.toml-read.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { dropUserSchemas } from "../../../command-internal/drop-objects.ts";
import {
  hostedMutationPreapproval,
  requireTargetMutationConsent,
} from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { migrateAndSeed } from "../../../command-internal/migrate-and-seed.ts";
import { MigrationChecksSkipped } from "../../../command-internal/migration-checks.ts";
import {
  listRemoteMigrations,
  withTargetFlags,
} from "../../../command-internal/migration-history.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { flagsForTarget } from "../../../command-internal/target/target-flags.ts";
import { upsertVaultSecrets } from "../../../command-internal/vault.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { MigrationDownFlags } from "./down.command.ts";
import { MigrationLastTooLargeError, MigrationLastZeroError } from "./down.errors.ts";

const runDown = Effect.fnUntraced(function* (flags: MigrationDownFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;

  const target = yield* resolveTarget(flags);

  const downFlow = Effect.gen(function* () {
    // Resolves before `--last` validation, so an unlinked/invalid target error
    // surfaces before the `--last must be greater than 0` error.
    const cfg = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: Option.none(),
      networkBanRemoval: yield* hostedMutationPreapproval,
    });

    if (flags.last === 0) {
      return yield* new MigrationLastZeroError({ message: "--last must be greater than 0" });
    }

    const ref = Option.getOrUndefined(cfg.ref ?? Option.none());
    const toml = yield* readDbToml(fs, path, cliSettings.workdir, ref);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connection.connect(cfg.conn, {
          isLocal: cfg.isLocal,
          dnsResolver,
        });

        const remote = yield* listRemoteMigrations(session);
        const total = remote.length;
        const version = remote[total - flags.last - 1];
        if (total <= flags.last || version === undefined) {
          return yield* new MigrationLastTooLargeError({
            message: `--last must be smaller than total applied migrations: ${total}`,
            suggestion: `Try ${aqua(withTargetFlags("supabase db reset", flagsForTarget(target)))} if you want to revert all migrations.`,
          });
        }

        yield* requireTargetMutationConsent(cfg, {
          action: `Reset the database to version ${version}`,
          details: [
            "Reverts the following migrations:",
            ...remote.slice(total - flags.last).map((reverted) => ` • ${bold(reverted)}`),
            `${yellow("WARNING:")} you will lose all data in this database.`,
          ],
        });

        yield* output.raw(`Resetting database to version: ${version}\n`, "stderr");
        yield* Effect.annotateCurrentSpan({
          "db.is_local": cfg.isLocal,
          "migration.version": version,
          "migration.last": flags.last,
        });
        yield* dropUserSchemas(session);
        yield* upsertVaultSecrets(session, toml.vault);
        yield* migrateAndSeed(session, fs, path, cliSettings.workdir, version, {
          migrationsEnabled: toml.migrationsEnabled,
          seed: toml.seed,
          // `version` is always non-empty here, so `migrateAndSeed`'s empty-version
          // branch never triggers regardless of these three flags.
          experimental: false,
          pgDeltaEnabled: false,
          schemaPaths: [],
          checks: toml,
        }).pipe(Effect.provideService(MigrationChecksSkipped, flags.skipChecks));

        if (output.format !== "text") {
          yield* output.success("Migrations reverted", { version, last: flags.last });
        }
      }),
    );
  });

  // Attached to the whole flow via `Effect.ensuring` so the cache write still
  // runs on the `--last`/decline failure paths.
  if (target.kind === "linked") {
    const linkedProjectCache = yield* LinkedProjectCache;
    return yield* downFlow.pipe(Effect.ensuring(linkedProjectCache.cache(target.ref)));
  }
  return yield* downFlow;
});

export const migrationDown = Effect.fn("migration.down")(function* (flags: MigrationDownFlags) {
  const telemetryState = yield* TelemetryState;
  yield* runDown(flags).pipe(Effect.ensuring(telemetryState.flush));
});
