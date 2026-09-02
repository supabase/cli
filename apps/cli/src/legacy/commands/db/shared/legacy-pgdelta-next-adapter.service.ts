import type { Pool } from "pg";
import { Context, Data, type Effect } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import type { LegacyMigrationTransactionMode } from "../../../shared/legacy-migration-file.ts";
import type {
  LegacyPgDeltaErrorDiagnostic,
  LegacyPgDeltaExportManifest,
  LegacyPgDeltaHazardReport,
  LegacyPgDeltaRemovalSummary,
} from "./legacy-pgdelta-engine.service.ts";

export type LegacyPgDeltaNextOperation =
  | "diff"
  | "declarativeExport"
  | "declarativePlan"
  | "snapshotCapture";

export type LegacyPgDeltaNextDiagnosticOrigin =
  | "source"
  | "desired"
  | "export"
  | "declarativeLoad"
  | "declarativeTarget"
  | "declarativeDrift"
  | "plan"
  | "snapshot";

export interface LegacyPgDeltaNextDiagnostic {
  readonly origin: LegacyPgDeltaNextDiagnosticOrigin;
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly subject?: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface LegacyPgDeltaNextRenderedFile {
  readonly sequence: number;
  readonly suffix: string | null;
  readonly sql: string;
  readonly transactionMode: LegacyMigrationTransactionMode;
  readonly actionCount: number;
}

export type LegacyPgDeltaNextHazardReport = LegacyPgDeltaHazardReport;

export interface LegacyPgDeltaNextSqlFile {
  readonly name: string;
  readonly sql: string;
}

interface LegacyPgDeltaNextDebugArtifacts {
  readonly sourceSnapshot?: string;
  readonly desiredSnapshot?: string;
  readonly plan?: string;
}

export interface LegacyPgDeltaNextDiffInput {
  /** The live database the rendered migration will be applied to. */
  readonly sourcePool: Pool;
  /** The live database whose state is desired. */
  readonly desiredPool: Pool;
  readonly allowDrops: boolean;
  readonly debug: boolean;
  readonly schema?: readonly string[];
  readonly formatOptions?: string;
}

interface LegacyPgDeltaNextDiffResult {
  readonly changes: boolean;
  readonly sql: string;
  readonly files: readonly LegacyPgDeltaNextRenderedFile[];
  readonly diagnostics: readonly LegacyPgDeltaNextDiagnostic[];
  readonly hazards: LegacyPgDeltaNextHazardReport;
  readonly debug?: LegacyPgDeltaNextDebugArtifacts;
}

export interface LegacyPgDeltaNextDeclarativeExportInput {
  readonly pool: Pool;
  readonly schema?: readonly string[];
  readonly formatOptions?: string;
}

export type LegacyPgDeltaNextExportManifest = LegacyPgDeltaExportManifest;

interface LegacyPgDeltaNextDeclarativeExportResult {
  readonly files: readonly LegacyPgDeltaNextSqlFile[];
  readonly manifest: LegacyPgDeltaNextExportManifest;
  readonly diagnostics: readonly LegacyPgDeltaNextDiagnostic[];
}

export interface LegacyPgDeltaNextDeclarativePlanInput {
  readonly targetPool: Pool;
  readonly shadowPool: Pool;
  readonly files: readonly LegacyPgDeltaNextSqlFile[];
  readonly allowDrops: boolean;
  readonly allowSameDatabaseIdentity?: boolean;
  readonly debug: boolean;
  readonly manifest?: LegacyPgDeltaNextExportManifest;
  readonly formatOptions?: string;
  readonly schema?: readonly string[];
}

interface LegacyPgDeltaNextSkippedStatement {
  readonly file: string;
  readonly statement: string;
}

interface LegacyPgDeltaNextDeclarativePlanResult {
  readonly changes: boolean;
  readonly sql: string;
  readonly files: readonly LegacyPgDeltaNextRenderedFile[];
  readonly diagnostics: readonly LegacyPgDeltaNextDiagnostic[];
  readonly hazards: LegacyPgDeltaNextHazardReport;
  readonly skipped: readonly LegacyPgDeltaNextSkippedStatement[];
  readonly removals: LegacyPgDeltaRemovalSummary;
  readonly debug?: LegacyPgDeltaNextDebugArtifacts;
}

export interface LegacyPgDeltaNextSnapshotCaptureInput {
  readonly pool: Pool;
}

interface LegacyPgDeltaNextSnapshotCaptureResult {
  readonly generation: "v2";
  readonly snapshot: string;
  readonly pgVersion: string;
  readonly diagnostics: readonly LegacyPgDeltaNextDiagnostic[];
}

export class LegacyPgDeltaNextError extends Data.TaggedError("LegacyPgDeltaNextError")<{
  readonly operation: LegacyPgDeltaNextOperation;
  readonly message: string;
  readonly cause: unknown;
  readonly diagnostics?: readonly LegacyPgDeltaErrorDiagnostic[];
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

export interface LegacyPgDeltaNextAdapterShape {
  readonly diff: (
    input: LegacyPgDeltaNextDiffInput,
  ) => Effect.Effect<LegacyPgDeltaNextDiffResult, LegacyPgDeltaNextError>;
  readonly exportDeclarativeSchema: (
    input: LegacyPgDeltaNextDeclarativeExportInput,
  ) => Effect.Effect<LegacyPgDeltaNextDeclarativeExportResult, LegacyPgDeltaNextError>;
  readonly planDeclarativeSchema: (
    input: LegacyPgDeltaNextDeclarativePlanInput,
  ) => Effect.Effect<LegacyPgDeltaNextDeclarativePlanResult, LegacyPgDeltaNextError>;
  readonly captureSnapshot: (
    input: LegacyPgDeltaNextSnapshotCaptureInput,
  ) => Effect.Effect<LegacyPgDeltaNextSnapshotCaptureResult, LegacyPgDeltaNextError>;
}

export class LegacyPgDeltaNextAdapter extends Context.Service<
  LegacyPgDeltaNextAdapter,
  LegacyPgDeltaNextAdapterShape
>()("supabase/legacy/PgDeltaNextAdapter") {}
