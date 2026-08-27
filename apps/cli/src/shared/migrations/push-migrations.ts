import { Effect } from "effect";
import type { Pool } from "pg";
import { explicitBooleanLongFlag } from "../cli/cobra-flag-groups.ts";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { authorizeMutation } from "../database/destructive-auth.ts";
import type { DatabaseTarget } from "../database/database-target.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { Output } from "../output/output.service.ts";
import { assertNoUngeneratedDraft } from "../schema/declarations-ahead.ts";
import {
  formatMigrationInventory,
  formatPlanSql,
  humanTarget,
  planStatementCount,
  type SchemaScriptFile,
} from "../schema/schema-body.ts";
import {
  SchemaCancelledError,
  SchemaCatalogAdoptError,
  SchemaDeclarationsAheadError,
  SchemaDestructiveAuthError,
  SchemaHistoryConflictError,
  SchemaRemoteDriftError,
} from "../schema/schema-errors.ts";
import { formatNextAction } from "../schema/schema-output.ts";
import type { SchemaCommandResult, SchemaPlanView } from "../schema/schema-types.ts";
import { wrapShadowReplayOutput } from "../schema/shadow-replay-output.ts";
import { SchemaWorkspace } from "../schema/schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import type { MigrationFile } from "./migration-file.ts";
import { findMatchingPendingPrefix } from "./matching-pending-prefix.ts";
import {
  formatHistoryConflict,
  formatLiveEditCommands,
  formatMigrationRepairCommand,
  formatMigrationsPushCommand,
  repairFlagsForTarget,
  type MigrationRepairFlags,
} from "./migration-repair-suggest.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";
import {
  classifyPrivilegePlan,
  emptyPendingMigrationError,
  pendingHasPrivilegeSql,
  privilegeOfferError,
  PRIVILEGE_REFRESH_SUGGESTION,
} from "./privilege-offer.ts";
import { warnIfRemotePostgresMajorMismatch } from "./remote-postgres.ts";

export type PushMigrationsInput = {
  readonly yes: boolean;
  readonly projectRef?: string;
  readonly allowRemote: boolean;
  readonly dbUrl?: string;
  readonly skipVerify: boolean;
};

const MATCHING_PREFIX_BANNER =
  "Checking whether pending files already match the remote (shadow probe, not a live apply).";
const VERIFY_BANNER = "Ensuring declarations and migrations match before push.";
const VERIFY_IN_SYNC = "Declarations and migrations are in sync.";
const VERIFY_NOT_IN_SYNC = "Declarations and migrations are not in sync.";
const VERIFY_PENDING_SHADOW = "Replaying pending files on a shadow before live apply.";
const VERIFY_PENDING_OK =
  "Catalog matches migration replay; pending files were verified on a shadow.";
const PRIVILEGE_BANNER = "Remote default privileges differ from migration replay.";
const PRIVILEGE_DUMP_HEADER = "Detected host-vs-replay privilege SQL (will not run).";
const PRIVILEGE_PENDING_BANNER = "Pending privilege migration will run on the remote.";
const DECLARATIONS_AHEAD_GENERATE =
  "Update `supabase/schemas` to include hand-written migration changes, or run `supabase schema generate --name <feature>` if declarations are the intended state.";
const DECLARATIONS_AHEAD_REFRESH =
  "Declarations differ from migration replay by default privileges only. Run `supabase db reset` then `supabase schema pull --force` so declarations match the grant-kept baseline. Do not write GRANT ALL.";

const pendingScriptFiles = (
  pending: ReadonlyArray<{ readonly fileName: string; readonly version: string }>,
): ReadonlyArray<SchemaScriptFile> =>
  pending.map((file) => ({ name: file.fileName, version: file.version }));

const previewPending = Effect.fnUntraced(function* (
  pending: ReadonlyArray<{ readonly version: string; readonly name: string }>,
  target: DatabaseTarget,
) {
  const output = yield* Output;
  if (output.format !== "text") return;
  if (pending.length === 0) {
    yield* output.info(`No pending migrations. History matches files on ${humanTarget(target)}.`);
    return;
  }
  const inventory = formatMigrationInventory(
    pending.map((file) => ({ version: file.version, name: file.name })),
  );
  if (inventory.length > 0) {
    yield* output.raw(inventory.endsWith("\n") ? inventory : `${inventory}\n`);
  }
  const noun = pending.length === 1 ? "migration" : "migrations";
  yield* output.info(
    `${pending.length} pending ${noun} will be applied on ${humanTarget(target)}.`,
  );
});

const emitPlanSql = Effect.fnUntraced(function* (plan: SchemaPlanView) {
  const output = yield* Output;
  const sql = formatPlanSql(plan);
  if (output.format === "text") {
    const count = planStatementCount(plan);
    if (count > 0) {
      yield* output.info(`${count} ${count === 1 ? "statement" : "statements"}`);
    }
    if (sql.length > 0) {
      yield* output.raw(sql.endsWith("\n") ? sql : `${sql}\n`);
    }
  }
  return sql;
});

const refusePrivilegeOffer = Effect.fnUntraced(function* (
  plan: SchemaPlanView,
  flags: MigrationRepairFlags | undefined,
  files: ReadonlyArray<SchemaScriptFile>,
) {
  const output = yield* Output;
  yield* output.info(PRIVILEGE_BANNER);
  yield* output.info(PRIVILEGE_DUMP_HEADER);
  const sql = yield* emitPlanSql(plan);
  return yield* privilegeOfferError(sql, flags, files);
});

const refuseLiveEdit = Effect.fnUntraced(function* (
  plan: SchemaPlanView,
  flags: MigrationRepairFlags,
  files: ReadonlyArray<SchemaScriptFile>,
) {
  const sql = yield* emitPlanSql(plan);
  return yield* new SchemaRemoteDriftError({
    detail: "Remote database shape has drifted from migration replay.",
    suggestion: formatLiveEditCommands(flags),
    sql,
    files,
  });
});

const refusePrivilegeRefresh = (files: ReadonlyArray<SchemaScriptFile>) =>
  new SchemaRemoteDriftError({
    detail: "Remote privileges differ from migration replay.",
    suggestion: PRIVILEGE_REFRESH_SUGGESTION,
    files,
  });

const refuseCatalogAdopt = Effect.fnUntraced(function* (
  plan: SchemaPlanView,
  flags: MigrationRepairFlags,
  files: ReadonlyArray<SchemaScriptFile>,
) {
  const sql = yield* emitPlanSql(plan);
  return yield* new SchemaCatalogAdoptError({
    detail: "Remote catalog has objects but there is no migration history and no local files.",
    suggestion: formatLiveEditCommands(flags),
    sql,
    files,
  });
});

const refuseMatchingPrefix = (input: {
  readonly matching: ReadonlyArray<{ readonly version: string }>;
  readonly flags: MigrationRepairFlags;
  readonly files: ReadonlyArray<SchemaScriptFile>;
}) =>
  new SchemaRemoteDriftError({
    detail: "Remote catalog already matches these pending migration files.",
    suggestion: formatMigrationRepairCommand({
      status: "applied",
      versions: input.matching.map((file) => file.version),
      flags: input.flags,
    }),
    files: input.files,
  });

const probeMatchingPrefix = Effect.fnUntraced(function* (
  replayPool: Pool,
  remotePool: Pool,
  replayed: ReadonlyArray<MigrationFile>,
  pending: ReadonlyArray<MigrationFile>,
  flags: MigrationRepairFlags,
) {
  const output = yield* Output;
  yield* output.info(MATCHING_PREFIX_BANNER);
  const matching = yield* findMatchingPendingPrefix(replayPool, remotePool, replayed, pending);
  if (matching.length > 0) {
    return yield* refuseMatchingPrefix({
      matching,
      flags,
      files: pendingScriptFiles(pending),
    });
  }
});

const noteLocalPending = Effect.fnUntraced(function* (localFiles: ReadonlyArray<MigrationFile>) {
  if (localFiles.length === 0) return undefined;
  const targets = yield* DatabaseTargetResolver;
  const runner = yield* MigrationRunner;
  const local = yield* targets
    .resolve({ kind: "local" })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (local === undefined) return undefined;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* acquireDatabasePool(local.connectionString);
      const history = yield* runner
        .listRemote(pool)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (history === undefined) return undefined;
      const versions = new Set(history.map((row) => row.version));
      const pending = localFiles.filter((file) => !versions.has(file.version)).length;
      if (pending === 0) return undefined;
      const total = localFiles.length;
      return `${pending} of ${total} ${total === 1 ? "migration" : "migrations"} pending on the local database.`;
    }),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)));
});

const confirmFirstPushDirty = Effect.fnUntraced(function* (
  yes: boolean,
  flags?: MigrationRepairFlags,
) {
  if (yes) return;
  const output = yield* Output;
  if (output.interactive) {
    const ok = yield* output.promptConfirm(
      "Apply pending migrations on the remote despite this catalog difference?",
    );
    if (!ok) {
      return yield* new SchemaCancelledError({
        detail: "First push cancelled.",
        suggestion: `Re-run ${formatMigrationsPushCommand(flags)} after reviewing the SQL.`,
      });
    }
    return;
  }
  return yield* new SchemaDestructiveAuthError({
    detail: "Non-interactive first push of a catalog difference requires confirmation.",
    suggestion: "Re-run with --yes after reviewing the SQL, or abort.",
  });
});

export const pushMigrations = Effect.fn("migrations.push")(function* (input: PushMigrationsInput) {
  const targets = yield* DatabaseTargetResolver;
  const repository = yield* MigrationRepository;
  const runner = yield* MigrationRunner;
  const engine = yield* PgDeltaSchemaEngine;
  const workspace = yield* SchemaWorkspace;
  const output = yield* Output;

  yield* assertNoUngeneratedDraft();

  const remote = yield* targets.resolve(
    input.dbUrl !== undefined ? { kind: "url", url: input.dbUrl } : { kind: "linked" },
  );
  yield* authorizeMutation({
    target: remote,
    flags: {
      yes: input.yes,
      allowRemote: input.allowRemote,
      ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
    },
    command: "migrations push",
  });
  const localFiles = yield* repository.listLocal;
  const declarations = yield* workspace.readDeclarationFiles;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const remotePool = yield* acquireDatabasePool(remote.connectionString);
      const remoteHistory = yield* runner.listRemote(remotePool);
      const remoteVersions = new Set(remoteHistory.map((row) => row.version));
      const pending = localFiles.filter((file) => !remoteVersions.has(file.version));
      const remoteOnly = remoteHistory.filter(
        (row) => !localFiles.some((file) => file.version === row.version),
      );
      const flags = repairFlagsForTarget(remote, {
        ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
        ...(input.dbUrl !== undefined ? { dbUrl: input.dbUrl } : {}),
      });
      const emptyHistory = remoteHistory.length === 0;
      const files = pendingScriptFiles(pending);

      yield* warnIfRemotePostgresMajorMismatch(remotePool, remote);

      if (remoteOnly.length > 0) {
        return yield* new SchemaHistoryConflictError(
          formatHistoryConflict({
            remoteOnly: remoteOnly.map((row) => row.version),
            pending: pending.map((file) => file.version),
            flags,
          }),
        );
      }

      const emptyPending = emptyPendingMigrationError(pending);
      if (emptyPending !== undefined) {
        return yield* emptyPending;
      }

      yield* previewPending(pending, remote);

      const pendingPrivilege = yield* pendingHasPrivilegeSql(pending);

      let planSql: string | undefined;
      if (!input.skipVerify) {
        yield* output.info(VERIFY_BANNER);
        if (declarations.length > 0 && !pendingPrivilege) {
          const sourceShadow = yield* engine.provisionMigrations;
          const desiredShadow = yield* engine.provisionShadow;
          const sourcePool = yield* acquireDatabasePool(sourceShadow.url);
          const desiredPool = yield* acquireDatabasePool(desiredShadow.url);
          const ahead = yield* engine.planFiles({
            targetPool: sourcePool,
            shadowPool: desiredPool,
            files: declarations,
            allowDrops: true,
          });
          if (ahead.changes) {
            yield* output.info(VERIFY_NOT_IN_SYNC);
            const sql = yield* emitPlanSql(ahead);
            const aheadKind = yield* classifyPrivilegePlan(ahead);
            return yield* new SchemaDeclarationsAheadError({
              detail: "Declarations and local migration files have diverged.",
              suggestion:
                aheadKind === "not_acl" ? DECLARATIONS_AHEAD_GENERATE : DECLARATIONS_AHEAD_REFRESH,
              ...(sql.length > 0 ? { sql } : {}),
              files: ahead.files.map((file) => ({
                name: file.suffix ?? `schema-${file.sequence}.sql`,
                sql: file.sql,
              })),
            });
          }
        }

        const driftShadow = yield* engine.provisionPlatform;
        const replayPool = yield* acquireDatabasePool(driftShadow.url);
        const replayed = localFiles.filter((file) => remoteVersions.has(file.version));
        const replayOutput = wrapShadowReplayOutput(output, {
          debug: explicitBooleanLongFlag(process.argv, "debug") === true,
        });
        yield* runner
          .applyPending(replayPool, replayed)
          .pipe(Effect.provideService(Output, replayOutput));
        const drift = yield* engine.diffPools({
          sourcePool: replayPool,
          desiredPool: remotePool,
          allowDrops: true,
        });

        const privilegeKind = yield* classifyPrivilegePlan(drift);
        const privilegeOffer =
          emptyHistory && drift.changes && privilegeKind === "grant_present" && !pendingPrivilege;

        if (emptyHistory) {
          yield* output.info("No remote migration history yet. This is the first push.");
        }
        if (privilegeOffer) {
          return yield* refusePrivilegeOffer(drift, flags, files);
        }

        if (emptyHistory && drift.changes && pending.length === 0) {
          yield* output.info(VERIFY_NOT_IN_SYNC);
          return yield* refuseCatalogAdopt(drift, flags, files);
        }

        const pendingPrivilegeApply =
          drift.changes && pendingPrivilege && privilegeKind !== "not_acl";

        if (pendingPrivilegeApply) {
          yield* output.info(PRIVILEGE_PENDING_BANNER);
        } else if (emptyHistory && drift.changes && pending.length > 0) {
          yield* output.info(VERIFY_NOT_IN_SYNC);
          yield* probeMatchingPrefix(replayPool, remotePool, replayed, pending, flags).pipe(
            Effect.provideService(Output, replayOutput),
          );
          planSql = yield* emitPlanSql(drift);
          yield* confirmFirstPushDirty(input.yes, flags);
        } else if (
          !emptyHistory &&
          drift.changes &&
          privilegeKind !== "not_acl" &&
          !pendingPrivilege
        ) {
          return yield* refusePrivilegeRefresh(files);
        } else if (
          !emptyHistory &&
          drift.changes &&
          !(pendingPrivilege && privilegeKind !== "not_acl")
        ) {
          yield* output.info(VERIFY_NOT_IN_SYNC);
          yield* probeMatchingPrefix(replayPool, remotePool, replayed, pending, flags).pipe(
            Effect.provideService(Output, replayOutput),
          );
          return yield* refuseLiveEdit(drift, flags, files);
        } else if (drift.changes) {
          yield* output.info(VERIFY_NOT_IN_SYNC);
        }

        if (pending.length > 0) {
          yield* output.info(VERIFY_PENDING_SHADOW);
          // Full local inventory: applyPending treats a pending-only list as remote-only history.
          yield* runner
            .applyPending(replayPool, localFiles)
            .pipe(Effect.provideService(Output, replayOutput));
        }

        if (!drift.changes) {
          yield* output.info(pending.length > 0 ? VERIFY_PENDING_OK : VERIFY_IN_SYNC);
        }
      }

      const result = yield* runner.applyPending(remotePool, localFiles);
      const localPendingLine =
        result.applied.length > 0 ? yield* noteLocalPending(localFiles) : undefined;
      const nextActions =
        localPendingLine !== undefined
          ? [formatNextAction("to apply it locally", "supabase migrations apply")]
          : [];
      const pushed =
        result.applied.length === 0
          ? "Remote database is up to date."
          : `Pushed ${result.applied.length} migration(s) to ${remote.identity}.`;
      return {
        status: "clean",
        message: localPendingLine !== undefined ? `${pushed}\n${localPendingLine}` : pushed,
        data: {
          status: "clean",
          target: remote.identity,
          applied: result.applied,
          skipped: result.skipped,
          files,
          ...(planSql !== undefined ? { sql: planSql } : {}),
          mutated_database: result.applied.length > 0,
          mutated_files: false,
          next_actions: nextActions,
        },
        nextActions,
        mutatedDatabase: result.applied.length > 0,
        mutatedFiles: false,
      } satisfies SchemaCommandResult;
    }),
  );
});
