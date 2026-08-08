import { Effect, FileSystem, Path } from "effect";

import type { LegacyPgDeltaContext } from "../../../../shared/legacy-pgdelta.ts";
import type { LegacySetupInputs } from "../../../../shared/legacy-pgdelta.cache.ts";
import { legacyFindDropStatements } from "../../../../shared/legacy-sql-split.ts";
import {
  LegacyPgDeltaEngine,
  type LegacyPgDeltaDatabaseEndpoint,
  type LegacyPgDeltaRemovalSummary,
  type LegacyPgDeltaRenderedFile,
} from "../../shared/legacy-pgdelta-engine.service.ts";
import {
  LegacyLoadPgDeltaSqlFiles,
  LegacyReadPgDeltaExportManifest,
} from "../../shared/legacy-pgdelta-files.ts";
import { LegacyDeclarativeDiffError } from "./declarative.errors.ts";

/** Ambient inputs shared by the orchestration steps. */
export interface LegacyDeclarativeRunContext {
  readonly pgDelta: LegacyPgDeltaContext;
  readonly formatOptions: string;
  readonly declarativeDir: string;
  readonly schema: ReadonlyArray<string>;
  readonly noCache: boolean;
  readonly debug: boolean;
  readonly strictCoverage: boolean;
  readonly dnsResolver: "native" | "https";
  readonly linkedProjectRef?: string;
}

/** The output of a declarative-to-migrations diff. Mirrors Go's `SyncResult`. */
export interface LegacyDeclarativeSyncResult {
  readonly diffSQL: string;
  readonly files: ReadonlyArray<LegacyPgDeltaRenderedFile>;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly dropWarnings: ReadonlyArray<string>;
  readonly manifestPresent: boolean;
  readonly removals: LegacyPgDeltaRemovalSummary;
}

const declarativeError = (message: string) => new LegacyDeclarativeDiffError({ message });

/**
 * Computes the diff between local migrations state and the declarative schema.
 * Mirrors Go's `DiffDeclarativeToMigrations` (`declarative.go:170`): the
 * selected pg-delta engine owns both sides of the plan. The legacy engine
 * resolves migrations natively via `legacyGetMigrationsCatalogRef` (CLI-1959),
 * while pg-delta next plans against its scoped migrations/declarative shadows.
 */
export const legacyDiffDeclarativeToMigrations = Effect.fnUntraced(function* (
  run: LegacyDeclarativeRunContext,
  setupInputs: LegacySetupInputs,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const engine = yield* LegacyPgDeltaEngine;
  const exists = yield* fs.exists(run.declarativeDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* Effect.fail(
      declarativeError(
        "No declarative schema directory found. Run supabase db schema declarative generate first.",
      ),
    );
  }
  const files = yield* LegacyLoadPgDeltaSqlFiles(fs, path, run.declarativeDir).pipe(
    Effect.mapError((error) => declarativeError(error.message)),
  );
  const manifest = yield* LegacyReadPgDeltaExportManifest(fs, path, run.declarativeDir).pipe(
    Effect.mapError((error) => declarativeError(error.message)),
  );
  const result = yield* engine.planDeclarativeSchema({
    context: run.pgDelta,
    schema: run.schema,
    formatOptions: run.formatOptions,
    debug: run.debug,
    strictCoverage: run.strictCoverage,
    files,
    noCache: run.noCache,
    setupInputs,
    ...(run.linkedProjectRef !== undefined ? { projectRef: run.linkedProjectRef } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
  });
  return {
    diffSQL: result.sql,
    files: result.files,
    sourceRef: result.sourceRef,
    targetRef: result.targetRef,
    dropWarnings: legacyFindDropStatements(result.sql),
    manifestPresent: manifest !== undefined,
    removals: result.removals ?? { extensions: [], extensionIntents: [] },
  } satisfies LegacyDeclarativeSyncResult;
});

export const legacyGenerateDeclarativeOutput = Effect.fnUntraced(function* (
  run: LegacyDeclarativeRunContext,
  target: LegacyPgDeltaDatabaseEndpoint,
) {
  const engine = yield* LegacyPgDeltaEngine;
  return yield* engine.exportDeclarativeSchema({
    context: run.pgDelta,
    schema: run.schema,
    formatOptions: run.formatOptions,
    debug: run.debug,
    strictCoverage: run.strictCoverage,
    noCache: run.noCache,
    ...(run.linkedProjectRef !== undefined ? { projectRef: run.linkedProjectRef } : {}),
    target,
  });
});
