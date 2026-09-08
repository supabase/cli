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
import { aqua, bold, yellow } from "../../../command-internal/colors.ts";
import { loadProjectEnv, readDbToml } from "../../../command-internal/db-config.toml-read.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import { dropUserSchemas } from "../../../command-internal/drop-objects.ts";
import { migrateAndSeed } from "../../../command-internal/migrate-and-seed.ts";
import { listRemoteMigrations } from "../../../command-internal/migration-history.ts";
import { upsertVaultSecrets } from "../../../command-internal/vault.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { MigrationTargetFlagsError, OperationCanceledError } from "../migration.errors.ts";
import { migrationConfirm } from "../migration.prompt.ts";
import type { MigrationDownFlags } from "./down.command.ts";
import { MigrationLastTooLargeError, MigrationLastZeroError } from "./down.errors.ts";

const confirmResetAll = (pending: ReadonlyArray<string>): string => {
  let title = "Do you want to revert the following migrations?\n";
  for (const version of pending) title += ` • ${bold(version)}\n`;
  title += `${yellow("WARNING:")} you will lose all data in this database.`;
  return title;
};

const runDown = Effect.fnUntraced(function* (
  flags: MigrationDownFlags,
  target: ReturnType<typeof resolveDbTargetFlags>,
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;

  // Flag-group mutual-exclusion first: validated at
  // parse time, ahead of the root pre-run.
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new MigrationTargetFlagsError({
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
      new MigrationTargetFlagsError({
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
  const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);

  // Linked down caches the project ref, gated on the ref loaded in pre-run, NOT
  // on the handler's own failure. Load it now and attach the
  // cache to the whole flow via `Effect.ensuring`, so it runs even on the `--last`/cancel
  // failure paths.
  const cacheLinkedRef =
    connType === "linked"
      ? yield* Effect.gen(function* () {
          const projectRef = yield* ProjectRefResolver;
          const linkedProjectCache = yield* LinkedProjectCache;
          const linkedRef = yield* projectRef.loadProjectRef(flags.projectRef);
          return linkedProjectCache.cache(linkedRef);
        })
      : undefined;

  const downFlow = Effect.gen(function* () {
    // `--last` zero-value validation runs after DB-config resolution.
    if (flags.last === 0) {
      return yield* Effect.fail(
        new MigrationLastZeroError({ message: "--last must be greater than 0" }),
      );
    }

    const ref = Option.getOrUndefined(cfg.ref ?? Option.none());
    const toml = yield* readDbToml(fs, path, cliSettings.workdir, ref);

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

        const remote = yield* listRemoteMigrations(session);
        const total = remote.length;
        if (total <= flags.last) {
          return yield* Effect.fail(
            new MigrationLastTooLargeError({
              message: `--last must be smaller than total applied migrations: ${total}`,
              suggestion: `Try ${aqua("supabase db reset")} if you want to revert all migrations.`,
            }),
          );
        }

        const confirmed = yield* migrationConfirm(
          confirmResetAll(remote.slice(total - flags.last)),
          {
            defaultValue: false,
            yes,
          },
        );
        if (!confirmed) {
          return yield* Effect.fail(
            new OperationCanceledError({ message: CONTEXT_CANCELED_MESSAGE }),
          );
        }

        const version = remote[total - flags.last - 1]!;
        yield* output.raw(`Resetting database to version: ${version}\n`, "stderr");
        yield* dropUserSchemas(session);
        yield* upsertVaultSecrets(session, toml.vault);
        yield* migrateAndSeed(session, fs, path, cliSettings.workdir, version, {
          migrationsEnabled: toml.migrationsEnabled,
          seed: toml.seed,
          // `version` is always non-empty here (`migration down` reverts to a concrete
          // target) — the empty-version half of `migrateAndSeed`'s declarative
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

export const migrationDown = Effect.fn("migration.down")(function* (flags: MigrationDownFlags) {
  const telemetryState = yield* TelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveDbTargetFlags(cliArgs.args);
  yield* runDown(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
