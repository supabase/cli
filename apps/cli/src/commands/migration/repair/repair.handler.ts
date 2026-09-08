import { Effect, FileSystem, Option, Path } from "effect";

import {
  DnsResolverFlag,
  resolveYesWithProjectEnv,
} from "../../../command-internal/global-flags.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { emitSuccessTrailer } from "../../../shared/cli/success-trailer.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../shared/output/errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { loadProjectEnv } from "../../../command-internal/db-config.toml-read.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection, type DbSession } from "../../../command-internal/db-connection.service.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import {
  DELETE_MIGRATION_VERSION,
  type MigrationFile,
  createMigrationTable,
  loadLocalVersions,
  readMigrationFile,
  resolveMigrationFile,
  TRUNCATE_VERSION_TABLE,
  UPSERT_MIGRATION_VERSION,
} from "../../../command-internal/migration-history.ts";
import { parseMigrationVersion } from "../../../command-internal/migration-timestamp.format.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  MigrationFileNotFoundError,
  MigrationInvalidVersionError,
  MigrationPasswordFlagsError,
  MigrationTargetFlagsError,
  OperationCanceledError,
} from "../migration.errors.ts";
import { migrationConfirm } from "../migration.prompt.ts";
import { MigrationRepairUpdateError } from "./repair.errors.ts";

export interface MigrationRepairInput {
  readonly versions: ReadonlyArray<string>;
  readonly status: "applied" | "reverted";
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
  readonly projectRef: Option.Option<string>;
  readonly password: Option.Option<string>;
}

/** Creates the migration table, then runs one batch transaction. */
const updateMigrationTable = Effect.fnUntraced(function* (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
  versions: ReadonlyArray<string>,
  status: "applied" | "reverted",
  repairAll: boolean,
) {
  const output = yield* Output;
  yield* createMigrationTable(session);

  // Resolve the applied rows up front (each file is read while queueing the
  // batch, before sending it — a missing file aborts with no DB mutation).
  const appliedFiles: Array<MigrationFile> = [];
  if (status === "applied") {
    for (const version of versions) {
      const resolved = yield* resolveMigrationFile(fs, path, migrationsDir, version);
      if (Option.isNone(resolved)) {
        return yield* Effect.fail(
          new MigrationFileNotFoundError({
            message: `glob supabase/migrations/${version}_*.sql: file does not exist`,
          }),
        );
      }
      appliedFiles.push(yield* readMigrationFile(fs, path, resolved.value));
    }
  }

  const txn = Effect.gen(function* () {
    yield* session.exec("BEGIN");
    if (repairAll) yield* session.exec(TRUNCATE_VERSION_TABLE);
    if (status === "applied") {
      for (const file of appliedFiles) {
        yield* session.query(UPSERT_MIGRATION_VERSION, [file.version, file.name, file.statements]);
      }
    } else if (!repairAll) {
      yield* session.query(DELETE_MIGRATION_VERSION, [versions]);
    }
    yield* session.exec("COMMIT");
  });
  yield* txn.pipe(
    Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)),
    Effect.mapError(
      (cause) =>
        new MigrationRepairUpdateError({
          message: `failed to update migration table: ${cause.message}`,
        }),
    ),
  );

  // Printed only when NOT repairing the whole table.
  if (!repairAll) {
    yield* output.raw(
      `Repaired migration history: [${versions.join(" ")}] => ${status}\n`,
      "stderr",
    );
  }
});

const runRepair = Effect.fnUntraced(function* (
  input: MigrationRepairInput,
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
  if (Option.isSome(input.dbUrl) && Option.isSome(input.password)) {
    return yield* Effect.fail(
      new MigrationPasswordFlagsError({
        message:
          "if any flags in the group [db-url password] are set none of the others can be; [db-url password] were all set",
      }),
    );
  }

  const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");
  const repairAll = input.versions.length === 0;
  const connType = target.connType ?? "linked"; // repair defaults to `--linked`.

  // `--project-ref` never implies `--linked` and must not be silently
  // discarded on a non-linked target — see push.handler.ts's identical guard
  // (db push) for the full TS-only rationale.
  if (Option.isSome(input.projectRef) && connType !== "linked") {
    return yield* Effect.fail(
      new MigrationTargetFlagsError({
        message:
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      }),
    );
  }

  // Resolve the DB config (and, for the linked default, the project ref) BEFORE the
  // version parse and any prompt, so an
  // unlinked / invalid-config / malformed-`--db-url` run surfaces that error before an
  // invalid positional version or a prompt.
  const cfg = yield* resolver.resolve({
    dbUrl: input.dbUrl,
    connType,
    dnsResolver,
    password: input.password,
    linkedProjectRef: input.projectRef,
  });

  // The project .env loads after the parse-time flag-group validation above — so a
  // SUPABASE_YES set only in supabase/.env auto-confirms the repair-all prompt, but a
  // flag conflict still surfaces before any .env read. Resolve --yes against the
  // project env here, not just process.env.
  const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);

  // Linked repair caches the project ref + identifies project groups, gated on the
  // command having executed, NOT on the handler's own failure. The ref is loaded now
  // (pre-run), and the cache is attached to the whole
  // repair flow via `Effect.ensuring` below — so it runs even when the version parse fails
  // or the repair-all prompt is declined (caches on cancellation too).
  const cacheLinkedRef =
    connType === "linked"
      ? yield* Effect.gen(function* () {
          const projectRef = yield* ProjectRefResolver;
          const linkedProjectCache = yield* LinkedProjectCache;
          const ref = yield* projectRef.loadProjectRef(input.projectRef);
          return linkedProjectCache.cache(ref);
        })
      : undefined;

  const repairFlow = Effect.gen(function* () {
    // Version validation runs after DB-config resolution. Rejects non-numeric AND
    // out-of-int64-range values; `parseMigrationVersion` mirrors that exactly.
    for (const version of input.versions) {
      if (parseMigrationVersion(version) === undefined) {
        return yield* Effect.fail(
          new MigrationInvalidVersionError({
            message: `failed to parse ${version}: invalid version number`,
          }),
        );
      }
    }

    // repair-all confirmation (default NO). Then load every local version.
    let versions = input.versions;
    if (repairAll) {
      const confirmed = yield* migrationConfirm(
        "Do you want to repair the entire migration history table to match local migration files?",
        { defaultValue: false, yes },
      );
      if (!confirmed) {
        return yield* Effect.fail(
          new OperationCanceledError({ message: CONTEXT_CANCELED_MESSAGE }),
        );
      }
      versions = yield* loadLocalVersions(fs, path, migrationsDir);
    }

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
        yield* updateMigrationTable(
          session,
          fs,
          path,
          migrationsDir,
          versions,
          input.status,
          repairAll,
        );
      }),
    );

    if (output.format === "text") {
      // The success banner (stdout) + follow-up suggestion (stderr), both on success.
      yield* output.raw(`Finished ${aqua("supabase migration repair")}.\n`);
      yield* emitSuccessTrailer(
        `Run ${aqua("supabase migration list")} to show the updated migration history.\n`,
      );
    } else {
      yield* output.success("Migration history repaired", {
        versions,
        status: input.status,
        repairAll,
      });
    }
  });

  return yield* cacheLinkedRef === undefined
    ? repairFlow
    : repairFlow.pipe(Effect.ensuring(cacheLinkedRef));
});

export const migrationRepair = Effect.fn("migration.repair")(function* (
  input: MigrationRepairInput,
) {
  const telemetryState = yield* TelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveDbTargetFlags(cliArgs.args);
  yield* runRepair(input, target).pipe(Effect.ensuring(telemetryState.flush));
});
