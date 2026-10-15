import { Effect, FileSystem, Option, Path } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { emitSuccessTrailer } from "../../../shared/cli/success-trailer.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection, type DbSession } from "../../../command-internal/db-connection.service.ts";
import {
  hostedMutationPreapproval,
  requireTargetMutationConsent,
} from "../../../command-internal/hosted-consent/hosted-consent.ts";
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
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { MigrationFileNotFoundError, MigrationInvalidVersionError } from "../migration.errors.ts";
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
const updateMigrationTable = Effect.fn("MigrationRepair.updateMigrationTable")(function* (
  session: DbSession,
  appliedFiles: ReadonlyArray<MigrationFile>,
  versions: ReadonlyArray<string>,
  status: "applied" | "reverted",
  repairAll: boolean,
) {
  const output = yield* Output;
  yield* createMigrationTable(session);

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

  // Printed only when not repairing the whole table.
  if (!repairAll) {
    yield* output.raw(
      `Repaired migration history: [${versions.join(" ")}] => ${status}\n`,
      "stderr",
    );
  }
});

const repairPlan = (
  versions: ReadonlyArray<string>,
  status: "applied" | "reverted",
  repairAll: boolean,
) => {
  if (!repairAll) {
    return {
      action: `Mark ${versions.length} ${versions.length === 1 ? "migration" : "migrations"} as ${status}`,
      details: versions.map((version) => ` • ${version}`),
    };
  }
  return status === "applied"
    ? {
        action: `Replace the migration history table with ${versions.length} local ${versions.length === 1 ? "migration" : "migrations"}`,
        details: [],
      }
    : { action: "Clear the migration history table", details: [] };
};

const runRepair = Effect.fnUntraced(function* (input: MigrationRepairInput) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;

  const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");
  const repairAll = input.versions.length === 0;

  const target = yield* resolveTarget(input);

  const repairFlow = Effect.gen(function* () {
    // Resolves the connection before the version parse and any prompt, so an invalid
    // target surfaces first.
    const cfg = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: input.password,
      hasPasswordFlag: true,
      networkBanRemoval: yield* hostedMutationPreapproval,
    });
    yield* Effect.annotateCurrentSpan({
      "db.conn_type": target.kind,
      "db.is_local": cfg.isLocal,
      "migration.repair_all": repairAll,
      "migration.status": input.status,
    });

    // Rejects non-numeric and out-of-int64-range values.
    for (const version of input.versions) {
      if (parseMigrationVersion(version) === undefined) {
        return yield* new MigrationInvalidVersionError({
          message: `failed to parse ${version}: invalid version number`,
        });
      }
    }

    const versions = repairAll ? yield* loadLocalVersions(fs, path, migrationsDir) : input.versions;

    // Every file is read before the first write, so a missing file aborts with no DB mutation.
    const appliedFiles: Array<MigrationFile> = [];
    if (input.status === "applied") {
      for (const version of versions) {
        const resolved = yield* resolveMigrationFile(fs, path, migrationsDir, version);
        if (Option.isNone(resolved)) {
          return yield* new MigrationFileNotFoundError({
            message: `glob supabase/migrations/${version}_*.sql: file does not exist`,
          });
        }
        appliedFiles.push(yield* readMigrationFile(fs, path, resolved.value));
      }
    }

    yield* requireTargetMutationConsent(cfg, repairPlan(versions, input.status, repairAll));

    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connection.connect(cfg.conn, {
          isLocal: cfg.isLocal,
          dnsResolver,
        });
        yield* updateMigrationTable(session, appliedFiles, versions, input.status, repairAll);
      }),
    );

    if (output.format === "text") {
      // Success banner to stdout; follow-up suggestion to stderr.
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

  // Attached to the whole flow via `Effect.ensuring` so the cache write still runs even when
  // the version parse fails or the consent is declined.
  if (target.kind === "linked") {
    const linkedProjectCache = yield* LinkedProjectCache;
    return yield* repairFlow.pipe(Effect.ensuring(linkedProjectCache.cache(target.ref)));
  }
  return yield* repairFlow;
});

export const migrationRepair = Effect.fn("migration.repair")(function* (
  input: MigrationRepairInput,
) {
  const telemetryState = yield* TelemetryState;
  yield* runRepair(input).pipe(Effect.ensuring(telemetryState.flush));
});
