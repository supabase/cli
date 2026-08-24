import { Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../../shared/output/errors.ts";
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
  readonly projectRef: Option.Option<string>;
  readonly password: Option.Option<string>;
}

/** Creates the migration table, then runs one batch transaction. */
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

  // Resolve the applied rows up front (each file is read while queueing the
  // batch, before sending it — a missing file aborts with no DB mutation).
  const appliedFiles: Array<LegacyMigrationFile> = [];
  if (status === "applied") {
    for (const version of versions) {
      const resolved = yield* legacyResolveMigrationFile(fs, path, migrationsDir, version);
      if (Option.isNone(resolved)) {
        return yield* new LegacyMigrationFileNotFoundError({
          message: `glob supabase/migrations/${version}_*.sql: file does not exist`,
        });
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

  // Printed only when NOT repairing the whole table.
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
  const projectRef = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;

  if (target.setFlags.length > 1) {
    return yield* new LegacyMigrationTargetFlagsError({
      message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
    });
  }
  if (Option.isSome(input.dbUrl) && Option.isSome(input.password)) {
    return yield* new LegacyMigrationPasswordFlagsError({
      message:
        "if any flags in the group [db-url password] are set none of the others can be; [db-url password] were all set",
    });
  }

  const migrationsDir = path.join(cliConfig.workdir, "supabase", "migrations");
  const repairAll = input.versions.length === 0;
  const connType = target.connType ?? "linked"; // repair defaults to `--linked`.

  // `--project-ref` never implies `--linked` and must not be silently
  // discarded on a non-linked target — see push.handler.ts's identical guard
  // (db push) for the full TS-only rationale.
  if (Option.isSome(input.projectRef) && connType !== "linked") {
    return yield* new LegacyMigrationTargetFlagsError({
      message:
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
    });
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
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);

  // Linked repair caches the project ref + identifies project groups, gated on the
  // command having executed, NOT on the handler's own failure. The ref is loaded now
  // (pre-run), and the cache is attached to the whole
  // repair flow via `Effect.ensuring` below — so it runs even when the version parse fails
  // or the repair-all prompt is declined (caches on cancellation too).
  const linkedRef =
    connType === "linked" ? yield* projectRef.loadProjectRef(input.projectRef) : undefined;
  const cacheLinkedRef = linkedRef === undefined ? undefined : linkedProjectCache.cache(linkedRef);

  const repairFlow = Effect.gen(function* () {
    // Version validation runs after DB-config resolution. Rejects non-numeric AND
    // out-of-int64-range values; `legacyParseMigrationVersion` mirrors that exactly.
    for (const version of input.versions) {
      if (legacyParseMigrationVersion(version) === undefined) {
        return yield* new LegacyMigrationInvalidVersionError({
          message: `failed to parse ${version}: invalid version number`,
        });
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
        return yield* new LegacyOperationCanceledError({ message: CONTEXT_CANCELED_MESSAGE });
      }
      versions = yield* legacyLoadLocalVersions(fs, path, migrationsDir);
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
      yield* output.raw(`Finished ${legacyAqua("supabase migration repair")}.\n`);
      yield* emitSuccessTrailer(
        `Run ${legacyAqua("supabase migration list")} to show the updated migration history.\n`,
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
