import { Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import { legacyLoadProjectEnv } from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
} from "../../../shared/legacy-db-connection.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import {
  DELETE_MIGRATION_VERSION,
  type LegacyMigrationFile,
  legacyCreateMigrationTable,
  legacyLoadLocalVersions,
  legacyReadMigrationFile,
  legacyResolveMigrationFile,
  TRUNCATE_VERSION_TABLE,
  UPSERT_MIGRATION_VERSION,
} from "../../../shared/legacy-migration-history.ts";
import { legacyParseMigrationVersion } from "../../../shared/legacy-migration-timestamp.format.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacyMigrationFileNotFoundError,
  LegacyMigrationInvalidVersionError,
  LegacyMigrationPasswordFlagsError,
  LegacyMigrationTargetFlagsError,
  LegacyOperationCanceledError,
} from "../migration.errors.ts";
import { legacyMigrationConfirm } from "../migration.prompt.ts";
import { LegacyMigrationRepairUpdateError } from "./repair.errors.ts";

export interface LegacyMigrationRepairInput {
  readonly versions: ReadonlyArray<string>;
  readonly status: "applied" | "reverted";
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
  readonly password: Option.Option<string>;
}

/** Go's `repair.UpdateMigrationTable` — create the table, then run one batch txn. */
const updateMigrationTable = Effect.fnUntraced(function* (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
  versions: ReadonlyArray<string>,
  status: "applied" | "reverted",
  repairAll: boolean,
) {
  const output = yield* Output;
  yield* legacyCreateMigrationTable(session);

  // Resolve the applied rows up front (Go reads each file while queueing the
  // batch, before sending it — a missing file aborts with no DB mutation).
  const appliedFiles: Array<LegacyMigrationFile> = [];
  if (status === "applied") {
    for (const version of versions) {
      const resolved = yield* legacyResolveMigrationFile(fs, path, migrationsDir, version);
      if (Option.isNone(resolved)) {
        return yield* Effect.fail(
          new LegacyMigrationFileNotFoundError({
            message: `glob supabase/migrations/${version}_*.sql: file does not exist`,
          }),
        );
      }
      appliedFiles.push(yield* legacyReadMigrationFile(fs, path, resolved.value));
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
        new LegacyMigrationRepairUpdateError({
          message: `failed to update migration table: ${cause.message}`,
        }),
    ),
  );

  // Go prints this only when NOT repairing the whole table (`repair.go:82`).
  if (!repairAll) {
    yield* output.raw(
      `Repaired migration history: [${versions.join(" ")}] => ${status}\n`,
      "stderr",
    );
  }
});

const runRepair = Effect.fnUntraced(function* (
  input: LegacyMigrationRepairInput,
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
  if (Option.isSome(input.dbUrl) && Option.isSome(input.password)) {
    return yield* Effect.fail(
      new LegacyMigrationPasswordFlagsError({
        message:
          "if any flags in the group [db-url password] are set none of the others can be; [db-url password] were all set",
      }),
    );
  }

  const migrationsDir = path.join(cliConfig.workdir, "supabase", "migrations");
  const repairAll = input.versions.length === 0;
  const connType = target.connType ?? "linked"; // repair defaults to `--linked` (Go: `Bool("linked", true)`).

  // Resolve the DB config (and, for the linked default, the project ref) BEFORE the
  // version parse and any prompt — mirroring Go's cobra order: root `PersistentPreRunE`
  // runs `ParseDatabaseConfig` (`apps/cli-go/cmd/root.go:118`) before `repair.Run`'s
  // `strconv.Atoi` version loop (`internal/migration/repair/repair.go:27-31`). So an
  // unlinked / invalid-config / malformed-`--db-url` run surfaces that error before an
  // invalid positional version or a prompt.
  const cfg = yield* resolver.resolve({
    dbUrl: input.dbUrl,
    connType,
    dnsResolver,
    password: input.password,
  });

  // Go loads the project .env via loadNestedEnv INSIDE ParseDatabaseConfig (config.go:701),
  // after the parse-time flag-group validation above — so a SUPABASE_YES set only in
  // supabase/.env auto-confirms the repair-all prompt, but a flag conflict still surfaces
  // before any .env read. Resolve --yes against the project env here, not just process.env.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);

  // Linked repair caches the project ref + identifies project groups — Go's
  // `ensureProjectGroupsCached`, called from `Execute()` (`apps/cli-go/cmd/root.go:174`)
  // gated on `executedCmd != nil`, NOT on the RunE error. The ref is loaded now (pre-run,
  // via `ParseDatabaseConfig`'s `LoadProjectRef`), and the cache is attached to the whole
  // repair flow via `Effect.ensuring` below — so it runs even when the version parse fails
  // or the repair-all prompt is declined (Go caches on `context.Canceled` too).
  const cacheLinkedRef =
    connType === "linked"
      ? yield* Effect.gen(function* () {
          const projectRef = yield* LegacyProjectRefResolver;
          const linkedProjectCache = yield* LegacyLinkedProjectCache;
          const ref = yield* projectRef.loadProjectRef(Option.none());
          return linkedProjectCache.cache(ref);
        })
      : undefined;

  const repairFlow = Effect.gen(function* () {
    // Version validation runs after DB-config resolution (Go's `strconv.Atoi` loop lives
    // inside `repair.Run`, after `PersistentPreRunE`). Rejects non-numeric AND
    // out-of-int64-range values; `legacyParseMigrationVersion` mirrors that exactly.
    for (const version of input.versions) {
      if (legacyParseMigrationVersion(version) === undefined) {
        return yield* Effect.fail(
          new LegacyMigrationInvalidVersionError({
            message: `failed to parse ${version}: invalid version number`,
          }),
        );
      }
    }

    // repair-all confirmation (default NO). Then load every local version.
    let versions = input.versions;
    if (repairAll) {
      const confirmed = yield* legacyMigrationConfirm(
        "Do you want to repair the entire migration history table to match local migration files?",
        { defaultValue: false, yes },
      );
      if (!confirmed) {
        return yield* Effect.fail(
          new LegacyOperationCanceledError({ message: "context canceled" }),
        );
      }
      versions = yield* legacyLoadLocalVersions(fs, path, migrationsDir);
    }

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
      // Go's group PostRun (stdout) + root CmdSuggestion (stderr), both on success.
      yield* output.raw(`Finished ${legacyAqua("supabase migration repair")}.\n`);
      yield* output.raw(
        `Run ${legacyAqua("supabase migration list")} to show the updated migration history.\n`,
        "stderr",
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

export const legacyMigrationRepair = Effect.fn("legacy.migration.repair")(function* (
  input: LegacyMigrationRepairInput,
) {
  const telemetryState = yield* LegacyTelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  yield* runRepair(input, target).pipe(Effect.ensuring(telemetryState.flush));
});
