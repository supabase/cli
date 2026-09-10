import { Effect, FileSystem, Option, Path } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import { readDbToml } from "../../../command-internal/db-config.toml-read.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
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
import { upsertVaultSecrets } from "../../../command-internal/vault.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { MigrationTargetFlagsError } from "../migration.errors.ts";
import type { MigrationUpFlags } from "./up.command.ts";
import { MigrationMissingLocalError, MigrationMissingRemoteError } from "./up.errors.ts";

const suggestIgnoreFlag = (paths: ReadonlyArray<string>): string =>
  "\nRerun the command with --include-all flag to apply these migrations:\n" +
  `${bold(paths.join("\n"))}\n`;

const runUp = Effect.fnUntraced(function* (
  flags: MigrationUpFlags,
  target: ReturnType<typeof resolveDbTargetFlags>,
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;

  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new MigrationTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  // `--project-ref` never implies `--linked` and must not be silently
  // discarded on a non-linked target; see push.handler.ts's identical guard.
  if (Option.isSome(flags.projectRef) && (target.connType ?? "local") !== "linked") {
    return yield* Effect.fail(
      new MigrationTargetFlagsError({
        message:
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      }),
    );
  }

  const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");

  const upBody = Effect.gen(function* () {
    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType: target.connType ?? "local",
      dnsResolver,
      linkedProjectRef: flags.projectRef,
    });
    const ref = Option.getOrUndefined(cfg.ref ?? Option.none());
    const toml = yield* readDbToml(fs, path, cliSettings.workdir, ref);

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* output.raw(
          `Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`,
          "stderr",
        );
        const session = yield* connection.connect(cfg.conn, {
          isLocal: cfg.isLocal,
          dnsResolver,
        });

        const remote = yield* listRemoteMigrations(session);
        const local = yield* listLocalMigrationPaths(fs, path, migrationsDir);
        const result = findPendingMigrations(local, remote);

        let pending: ReadonlyArray<string>;
        if (result.kind === "missing-local") {
          return yield* Effect.fail(
            new MigrationMissingLocalError({
              message: "Remote migration versions not found in local migrations directory.",
              suggestion: suggestRevertHistory(
                result.versions,
                (target.connType ?? "local") === "local",
              ),
            }),
          );
        } else if (result.kind === "missing-remote") {
          if (!flags.includeAll) {
            return yield* Effect.fail(
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
          pending = [
            ...result.paths,
            ...sortMigrationPathsByVersion(local).slice(remote.length + result.paths.length),
          ];
        } else {
          pending = result.paths;
        }

        yield* upsertVaultSecrets(session, toml.vault);

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

  if ((target.connType ?? "local") === "linked") {
    const projectRef = yield* ProjectRefResolver;
    const linkedProjectCache = yield* LinkedProjectCache;
    const linkedRef = yield* projectRef.loadProjectRef(flags.projectRef);
    return yield* upBody.pipe(Effect.ensuring(linkedProjectCache.cache(linkedRef)));
  }
  return yield* upBody;
});

export const migrationUp = Effect.fn("migration.up")(function* (flags: MigrationUpFlags) {
  const telemetryState = yield* TelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveDbTargetFlags(cliArgs.args);
  yield* runUp(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
