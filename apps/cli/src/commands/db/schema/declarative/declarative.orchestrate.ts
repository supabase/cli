import { Effect, FileSystem, Path } from "effect";

import type { PgDeltaContext } from "../../../../command-internal/pgdelta.ts";
import type { DbTomlValues } from "../../../../command-internal/db-config.toml-read.ts";
import { findDropStatements } from "../../../../command-internal/sql-split.ts";
import {
  PgDeltaEngine,
  type PgDeltaDatabaseEndpoint,
  type PgDeltaRemovalSummary,
  type PgDeltaRenderedFile,
} from "../../shared/pgdelta-engine.service.ts";
import { LoadPgDeltaSqlFiles, ReadPgDeltaExportManifest } from "../../shared/pgdelta-files.ts";
import { DeclarativeCompatibilityError, DeclarativeDiffError } from "./declarative.errors.ts";
import {
  classifyDeclarativeLoadCompatibility,
  currentShellPlatform,
  formatDeclarativeUpgradeGate,
  type DeclarativeLoadCompatibilityFinding,
  type DeclarativeUpgradeGateText,
} from "./declarative.flow.ts";

/** Ambient inputs shared by the orchestration steps. */
export interface DeclarativeRunContext {
  readonly pgDelta: PgDeltaContext;
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
export interface DeclarativeSyncResult {
  readonly diffSQL: string;
  readonly files: ReadonlyArray<PgDeltaRenderedFile>;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly dropWarnings: ReadonlyArray<string>;
  readonly manifestPresent: boolean;
  readonly removals: PgDeltaRemovalSummary;
}

const declarativeError = (message: string) => new DeclarativeDiffError({ message });

const formatImplicitExtensionLoadFailure = (
  findings: ReadonlyArray<DeclarativeLoadCompatibilityFinding>,
  run: Pick<DeclarativeRunContext, "declarativeDirDisplay" | "schema">,
): DeclarativeUpgradeGateText =>
  formatDeclarativeUpgradeGate({
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
      platform: currentShellPlatform(),
    },
  });

/**
 * Computes the diff between local migrations state and the declarative schema.
 * The pg-delta engine owns both sides of the plan, planning against its scoped
 * migrations/declarative shadows.
 */
export const diffDeclarativeToMigrations = Effect.fnUntraced(function* (
  run: DeclarativeRunContext,
  toml: DbTomlValues,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const engine = yield* PgDeltaEngine;
  const exists = yield* fs.exists(run.declarativeDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* Effect.fail(
      declarativeError(
        "No declarative schema directory found. Run supabase db schema declarative generate first.",
      ),
    );
  }
  const files = yield* LoadPgDeltaSqlFiles(fs, path, run.declarativeDir).pipe(
    Effect.mapError((error) => declarativeError(error.message)),
  );
  // The planner reads ownership metadata from the export manifest when present.
  const manifest = yield* ReadPgDeltaExportManifest(fs, path, run.declarativeDir).pipe(
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
      ...(run.linkedProjectRef !== undefined ? { projectRef: run.linkedProjectRef } : {}),
      ...(manifest !== undefined ? { manifest } : {}),
    })
    .pipe(
      Effect.mapError((error) => {
        const findings = classifyDeclarativeLoadCompatibility({
          manifestPresent: manifest !== undefined,
          diagnostics: error.diagnostics ?? [],
          files,
        });
        if (findings.length === 0) return error;
        const gate = formatImplicitExtensionLoadFailure(findings, run);
        return new DeclarativeCompatibilityError({
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
        : findDropStatements(result.sql),
    manifestPresent: manifest !== undefined,
    removals: result.removals ?? { extensions: [], extensionIntents: [] },
  } satisfies DeclarativeSyncResult;
});

export const generateDeclarativeOutput = Effect.fnUntraced(function* (
  run: DeclarativeRunContext,
  target: PgDeltaDatabaseEndpoint,
) {
  const engine = yield* PgDeltaEngine;
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
