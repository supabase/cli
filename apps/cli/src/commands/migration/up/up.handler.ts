import { Effect, FileSystem, Match, Option, Path } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import { readDbToml } from "../../../command-internal/db-config.toml-read.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import {
  hostedMutationPreapproval,
  requireTargetMutationConsent,
} from "../../../command-internal/hosted-consent/hosted-consent.ts";
import {
  MigrationApplyError,
  applyMigrationFile,
} from "../../../command-internal/migration-apply.ts";
import {
  findPendingMigrations,
  listLocalMigrationPaths,
  listRemoteMigrations,
  sortMigrationPathsByVersion,
  suggestRevertHistory,
} from "../../../command-internal/migration-history.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { upsertVaultSecrets } from "../../../command-internal/vault.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { MigrationUpFlags } from "./up.command.ts";
import { MigrationMissingLocalError, MigrationMissingRemoteError } from "./up.errors.ts";

const suggestIgnoreFlag = (paths: ReadonlyArray<string>): string =>
  "\nRerun the command with --include-all flag to apply these migrations:\n" +
  `${bold(paths.join("\n"))}\n`;

const runUp = Effect.fnUntraced(function* (flags: MigrationUpFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;

  const target = yield* resolveTarget(flags);
  const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");

  const upBody = Effect.gen(function* () {
    const cfg = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: Option.none(),
      networkBanRemoval: yield* hostedMutationPreapproval,
    });
    const ref = Option.getOrUndefined(cfg.ref ?? Option.none());
    const toml = yield* readDbToml(fs, path, cliSettings.workdir, ref);
    yield* Effect.annotateCurrentSpan({
      "db.conn_type": target.kind,
      "db.is_local": cfg.isLocal,
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connection.connect(cfg.conn, {
          isLocal: cfg.isLocal,
          dnsResolver,
        });

        const remote = yield* listRemoteMigrations(session);
        const local = yield* listLocalMigrationPaths(fs, path, migrationsDir);
        const pending = yield* Match.value(findPendingMigrations(local, remote)).pipe(
          Match.discriminatorsExhaustive("kind")({
            "missing-local": (result) =>
              Effect.fail(
                new MigrationMissingLocalError({
                  message: "Remote migration versions not found in local migrations directory.",
                  suggestion: suggestRevertHistory(result.versions, target.kind === "local"),
                }),
              ),
            "missing-remote": (result) => {
              if (!flags.includeAll) {
                return Effect.fail(
                  new MigrationMissingRemoteError({
                    message:
                      "Found local migration files to be inserted before the last migration on remote database.",
                    suggestion: suggestIgnoreFlag(result.paths),
                  }),
                );
              }
              // Slices the same version-ordered list `result.paths` was taken from; indexing
              // a name-ordered list with this offset would skip a pending migration and
              // re-apply an already-applied one.
              return Effect.succeed([
                ...result.paths,
                ...sortMigrationPathsByVersion(local).slice(remote.length + result.paths.length),
              ]);
            },
            pending: (result) => Effect.succeed(result.paths),
          }),
        );

        const vaultSecrets = toml.vault.filter((secret) => secret.resolved);
        if (pending.length > 0 || vaultSecrets.length > 0) {
          yield* requireTargetMutationConsent(cfg, {
            action: `Apply ${pending.length} ${pending.length === 1 ? "migration" : "migrations"}`,
            details: [
              ...pending.map((migrationPath) => `Apply migration ${path.basename(migrationPath)}`),
              ...(vaultSecrets.length > 0
                ? [`Update ${vaultSecrets.length} vault ${vaultSecrets.length === 1 ? "secret" : "secrets"}`]
                : []),
            ],
          });
        }

        yield* upsertVaultSecrets(session, toml.vault);

        yield* Effect.annotateCurrentSpan({ "migration.count": pending.length });
        for (const migrationPath of pending) {
          yield* output.raw(`Applying migration ${path.basename(migrationPath)}...\n`, "stderr");
          yield* applyMigrationFile(
            session,
            fs,
            path,
            migrationPath,
            (message) => new MigrationApplyError({ message }),
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

  if (target.kind === "linked") {
    const linkedProjectCache = yield* LinkedProjectCache;
    return yield* upBody.pipe(Effect.ensuring(linkedProjectCache.cache(target.ref)));
  }
  return yield* upBody;
});

export const migrationUp = Effect.fn("migration.up")(function* (flags: MigrationUpFlags) {
  const telemetryState = yield* TelemetryState;
  yield* runUp(flags).pipe(Effect.ensuring(telemetryState.flush));
});
