import { Effect, FileSystem } from "effect";

import {
  type LegacyPgDeltaContext,
  legacyDeclarativeExportPgDelta,
  legacyDiffPgDelta,
} from "../../shared/legacy-pgdelta.ts";
import { LegacyDeclarativeDiffError } from "./declarative.errors.ts";
import { LegacyDeclarativeSeam } from "../../shared/legacy-pgdelta.seam.service.ts";
import { legacyFindDropStatements } from "../../../../shared/legacy-sql-split.ts";

/** Ambient inputs shared by the orchestration steps. */
export interface LegacyDeclarativeRunContext {
  readonly pgDelta: LegacyPgDeltaContext;
  /** `experimental.pgdelta.format_options` (trimmed; "" when unset). */
  readonly formatOptions: string;
  /** Resolved declarative schema dir (workdir-relative, e.g. `supabase/database`). */
  readonly declarativeDir: string;
  readonly schema: ReadonlyArray<string>;
  readonly noCache: boolean;
  /**
   * Resolved linked project ref for an explicit `generate --linked`. Threaded into
   * the baseline `__catalog` export so the Go config load merges the matching
   * `[remotes.<ref>]` override into the platform baseline (auth/storage/realtime/api/
   * vault settings), matching Go's `Generate`, which builds the baseline from the
   * remote-merged config. `undefined` for local/db-url/smart targets.
   */
  readonly linkedProjectRef?: string;
}

/** The output of a declarative-to-migrations diff. Mirrors Go's `SyncResult`. */
export interface LegacyDeclarativeSyncResult {
  readonly diffSQL: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly dropWarnings: ReadonlyArray<string>;
}

/**
 * Computes the diff between local migrations state and the declarative schema.
 * Mirrors Go's `DiffDeclarativeToMigrations` (`declarative.go:170`): the
 * migrations catalog (source) and declarative catalog (target) are provisioned
 * via the Go seam (shadow DB + `SetupDatabase` + migrate / apply), then diffed
 * natively with pg-delta.
 */
export const legacyDiffDeclarativeToMigrations = Effect.fnUntraced(function* (
  run: LegacyDeclarativeRunContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const seam = yield* LegacyDeclarativeSeam;

  const exists = yield* fs.exists(run.declarativeDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* Effect.fail(
      new LegacyDeclarativeDiffError({
        message:
          "No declarative schema directory found. Run supabase db schema declarative generate first.",
      }),
    );
  }

  const sourceRef = yield* seam.exportCatalog({ mode: "migrations", noCache: run.noCache });
  const targetRef = yield* seam.exportCatalog({ mode: "declarative", noCache: run.noCache });
  const diff = yield* legacyDiffPgDelta(run.pgDelta, {
    sourceRef,
    targetRef,
    schema: run.schema,
    formatOptions: run.formatOptions,
  });
  return {
    diffSQL: diff.sql,
    sourceRef,
    targetRef,
    dropWarnings: legacyFindDropStatements(diff.sql),
  } satisfies LegacyDeclarativeSyncResult;
});

/**
 * Exports a live database's schema as declarative file payloads, diffing it
 * against the platform-baseline catalog (provisioned via the Go seam). Mirrors
 * the catalog half of Go's `Generate` (`declarative.go:110`): the live database
 * URL is the target, the baseline is the source. The handler writes the
 * returned files after the overwrite prompt.
 */
export const legacyGenerateDeclarativeOutput = Effect.fnUntraced(function* (
  run: LegacyDeclarativeRunContext,
  targetDbUrl: string,
) {
  const seam = yield* LegacyDeclarativeSeam;
  const baselineRef = yield* seam.exportCatalog({
    mode: "baseline",
    noCache: run.noCache,
    ...(run.linkedProjectRef !== undefined ? { projectRef: run.linkedProjectRef } : {}),
  });
  return yield* legacyDeclarativeExportPgDelta(run.pgDelta, {
    sourceRef: baselineRef,
    targetRef: targetDbUrl,
    schema: run.schema,
    formatOptions: run.formatOptions,
  });
});
