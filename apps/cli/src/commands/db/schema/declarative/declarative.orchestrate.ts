import { Effect, FileSystem, Path } from "effect";

import type { LegacyPgDeltaContext } from "../../../../command-internal/legacy-pgdelta.ts";
import type { LegacyDbTomlValues } from "../../../../command-internal/legacy-db-config.toml-read.ts";
import { legacyFindDropStatements } from "../../../../command-internal/legacy-sql-split.ts";
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
import {
  LegacyDeclarativeCompatibilityError,
  LegacyDeclarativeDiffError,
} from "./declarative.errors.ts";
import {
  legacyClassifyDeclarativeLoadCompatibility,
  legacyCurrentShellPlatform,
  legacyFormatDeclarativeUpgradeGate,
  type LegacyDeclarativeLoadCompatibilityFinding,
  type LegacyDeclarativeUpgradeGateText,
} from "./declarative.flow.ts";

/** Ambient inputs shared by the orchestration steps. */
export interface LegacyDeclarativeRunContext {
  readonly pgDelta: LegacyPgDeltaContext;
  readonly formatOptions: string;
  readonly declarativeDir: string;
  /** User-facing configured/output path, kept separate from the absolute I/O path. */
  readonly declarativeDirDisplay: string;
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

const formatImplicitExtensionLoadFailure = (
  findings: ReadonlyArray<LegacyDeclarativeLoadCompatibilityFinding>,
  run: Pick<LegacyDeclarativeRunContext, "declarativeDirDisplay" | "schema">,
): LegacyDeclarativeUpgradeGateText =>
  legacyFormatDeclarativeUpgradeGate({
    evidence: findings.map((finding) => {
      const location =
        finding.file === undefined
          ? "A declarative schema file"
          : `${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`;
      return `${location} uses ${finding.signature}, but the tree does not declare ${finding.extension}.`;
    }),
    context: {
      declarativeDir: run.declarativeDirDisplay,
      schema: run.schema,
      platform: legacyCurrentShellPlatform(),
    },
  });

const legacyPlanDeclarative = Effect.fnUntraced(function* (
  run: LegacyDeclarativeRunContext,
  toml: LegacyDbTomlValues,
  source?: LegacyPgDeltaDatabaseEndpoint,
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
  // The planner reads ownership metadata from the export manifest when present.
  const manifest = yield* LegacyReadPgDeltaExportManifest(fs, path, run.declarativeDir).pipe(
    Effect.mapError((error) => declarativeError(error.message)),
  );
  const result = yield* engine
    .planDeclarativeSchema({
      context: run.pgDelta,
      schema: run.schema,
      formatOptions: run.formatOptions,
      debug: run.debug,
      strictCoverage: run.strictCoverage,
      files,
      noCache: run.noCache,
      toml,
      ...(source !== undefined ? { source } : {}),
      ...(run.linkedProjectRef !== undefined ? { projectRef: run.linkedProjectRef } : {}),
      ...(manifest !== undefined ? { manifest } : {}),
    })
    .pipe(
      Effect.mapError((error) => {
        const findings = legacyClassifyDeclarativeLoadCompatibility({
          manifestPresent: manifest !== undefined,
          diagnostics: error.diagnostics ?? [],
          files,
        });
        if (findings.length === 0) return error;
        const gate = formatImplicitExtensionLoadFailure(findings, run);
        return new LegacyDeclarativeCompatibilityError({
          message: gate.message,
          suggestion: gate.suggestion,
          loadFindings: findings,
        });
      }),
    );
  return {
    diffSQL: result.sql,
    files: result.files,
    sourceRef: result.sourceRef,
    targetRef: result.targetRef,
    dropWarnings:
      result.hazards !== undefined
        ? result.hazards.dataLoss.map((action) => action.sql)
        : legacyFindDropStatements(result.sql),
    manifestPresent: manifest !== undefined,
    removals: result.removals ?? { extensions: [], extensionIntents: [] },
  } satisfies LegacyDeclarativeSyncResult;
});

/** Plans from the local migrations state to the declarative schema. */
export const legacyDiffDeclarativeToMigrations = (
  run: LegacyDeclarativeRunContext,
  toml: LegacyDbTomlValues,
) => legacyPlanDeclarative(run, toml);

/** Plans from a live database to the declarative schema without migration history. */
export const legacyPlanDeclarativeToDatabase = (
  run: LegacyDeclarativeRunContext,
  toml: LegacyDbTomlValues,
  source: LegacyPgDeltaDatabaseEndpoint,
) => legacyPlanDeclarative(run, toml, source);

export const legacyGenerateDeclarativeOutput = Effect.fnUntraced(function* (
  run: LegacyDeclarativeRunContext,
  target: LegacyPgDeltaDatabaseEndpoint,
) {
  const engine = yield* LegacyPgDeltaEngine;
  return yield* engine.exportDeclarativeSchema({
    context: run.pgDelta,
    target,
    schema: run.schema,
    formatOptions: run.formatOptions,
    debug: run.debug,
    strictCoverage: run.strictCoverage,
    ...(run.linkedProjectRef !== undefined ? { projectRef: run.linkedProjectRef } : {}),
  });
});
