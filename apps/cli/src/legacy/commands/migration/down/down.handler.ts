import { Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../../shared/output/errors.ts";
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

  // Flag-group mutual-exclusion first: validated at
  // parse time, ahead of the root pre-run.
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyMigrationTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const connType = target.connType ?? "local"; // down defaults to `--local`.

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

  // Resolve the DB config BEFORE the `--last` validation, so an unlinked/invalid
  // target surfaces before the `--last must be greater than 0` error.
  const cfg = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    connType,
    dnsResolver,
    linkedProjectRef: flags.projectRef,
  });

  // The project .env loads after the parse-time flag-group validation above — so a
  // SUPABASE_YES set only in supabase/.env auto-confirms, but a flag conflict still
  // surfaces before any .env read. Resolve --yes against the project env here, not
  // just process.env.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);

  // Linked down caches the project ref, gated on the ref loaded in pre-run, NOT
  // on the handler's own failure. Load it now and attach the
  // cache to the whole flow via `Effect.ensuring`, so it runs even on the `--last`/cancel
  // failure paths.
  const cacheLinkedRef =
    connType === "linked"
      ? yield* Effect.gen(function* () {
          const projectRef = yield* LegacyProjectRefResolver;
          const linkedProjectCache = yield* LegacyLinkedProjectCache;
          const linkedRef = yield* projectRef.loadProjectRef(flags.projectRef);
          return linkedProjectCache.cache(linkedRef);
        })
      : undefined;

  const downFlow = Effect.gen(function* () {
    // `--last` zero-value validation runs after DB-config resolution.
    if (flags.last === 0) {
      return yield* Effect.fail(
        new LegacyMigrationLastZeroError({ message: "--last must be greater than 0" }),
      );
    }

    const ref = Option.getOrUndefined(cfg.ref ?? Option.none());
    const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir, ref);

    yield* Effect.scoped(
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
            new LegacyOperationCanceledError({ message: CONTEXT_CANCELED_MESSAGE }),
          );
        }

        const version = remote[total - flags.last - 1]!;
        yield* output.raw(`Resetting database to version: ${version}\n`, "stderr");
        yield* legacyDropUserSchemas(session);
        yield* legacyUpsertVaultSecrets(session, toml.vault);
        yield* legacyMigrateAndSeed(session, fs, path, cliConfig.workdir, version, {
          migrationsEnabled: toml.migrationsEnabled,
          seed: toml.seed,
          // `version` is always non-empty here (`migration down` reverts to a concrete
          // target) — the empty-version half of `legacyMigrateAndSeed`'s declarative
          // branch gate is therefore always false on this call site regardless of these
          // three values, matching the file's own doc comment.
          experimental: false,
          pgDeltaEnabled: false,
          schemaPaths: [],
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
