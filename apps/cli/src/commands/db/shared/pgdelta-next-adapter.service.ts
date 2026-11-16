import type { Pool } from "pg";
import { Context, Data, type Effect } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import type { MigrationTransactionMode } from "../../../command-internal/migration-file.ts";
import type {
  PgDeltaErrorDiagnostic,
  PgDeltaExportManifest,
  PgDeltaHazardReport,
  PgDeltaRemovalSummary,
} from "./pgdelta-engine.service.ts";

export type PgDeltaNextOperation =
  | "diff"
  | "declarativeExport"
  | "declarativePlan"
  | "snapshotCapture"
  | "sparkPlan"
  | "sparkExport";

export type PgDeltaNextDiagnosticOrigin =
  | "source"
  | "desired"
  | "export"
  | "declarativeLoad"
  | "declarativeTarget"
  | "declarativeDrift"
  | "plan"
  | "snapshot";

export interface PgDeltaNextDiagnostic {
  readonly origin: PgDeltaNextDiagnosticOrigin;
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly subject?: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface PgDeltaNextRenderedFile {
  readonly sequence: number;
  readonly suffix: string | null;
  readonly sql: string;
  readonly transactionMode: MigrationTransactionMode;
  readonly actionCount: number;
}

export type PgDeltaNextHazardReport = PgDeltaHazardReport;

export interface PgDeltaNextSqlFile {
  readonly name: string;
  readonly sql: string;
}

interface PgDeltaNextDebugArtifacts {
  readonly sourceSnapshot?: string;
  readonly desiredSnapshot?: string;
  readonly plan?: string;
}

export interface PgDeltaNextDiffInput {
  /** The live database the rendered migration will be applied to. */
  readonly sourcePool: Pool;
  /** The live database whose state is desired. */
  readonly desiredPool: Pool;
  readonly allowDrops: boolean;
  readonly debug: boolean;
  readonly schema?: readonly string[];
  readonly formatOptions?: string;
}

interface PgDeltaNextDiffResult {
  readonly changes: boolean;
  readonly sql: string;
  readonly files: readonly PgDeltaNextRenderedFile[];
  readonly diagnostics: readonly PgDeltaNextDiagnostic[];
  readonly hazards: PgDeltaNextHazardReport;
  readonly debug?: PgDeltaNextDebugArtifacts;
}

export interface PgDeltaNextDeclarativeExportInput {
  readonly pool: Pool;
  readonly schema?: readonly string[];
  readonly formatOptions?: string;
}

export type PgDeltaNextExportManifest = PgDeltaExportManifest;

interface PgDeltaNextDeclarativeExportResult {
  readonly files: readonly PgDeltaNextSqlFile[];
  readonly manifest: PgDeltaNextExportManifest;
  readonly diagnostics: readonly PgDeltaNextDiagnostic[];
}

export interface PgDeltaNextDeclarativePlanInput {
  readonly targetPool: Pool;
  readonly shadowPool: Pool;
  readonly files: readonly PgDeltaNextSqlFile[];
  readonly allowDrops: boolean;
  readonly allowSameDatabaseIdentity?: boolean;
  readonly debug: boolean;
  readonly manifest?: PgDeltaNextExportManifest;
  readonly formatOptions?: string;
  readonly schema?: readonly string[];
}

interface PgDeltaNextSkippedStatement {
  readonly file: string;
  readonly statement: string;
}

interface PgDeltaNextDeclarativePlanResult {
  readonly changes: boolean;
  readonly sql: string;
  readonly files: readonly PgDeltaNextRenderedFile[];
  readonly diagnostics: readonly PgDeltaNextDiagnostic[];
  readonly hazards: PgDeltaNextHazardReport;
  readonly skipped: readonly PgDeltaNextSkippedStatement[];
  readonly removals: PgDeltaRemovalSummary;
  readonly debug?: PgDeltaNextDebugArtifacts;
}

export interface PgDeltaNextSnapshotCaptureInput {
  readonly pool: Pool;
}

export interface PgDeltaNextSnapshotCaptureResult {
  readonly generation: "v2";
  readonly snapshot: string;
  readonly pgVersion: string;
  readonly diagnostics: readonly PgDeltaNextDiagnostic[];
}

/** A Spark project's API: the stack's public URL and its service_role key. */
export interface PgDeltaNextSparkConnection {
  readonly url: string;
  readonly key: string;
}

export interface PgDeltaNextSparkPlanInput {
  readonly connection: PgDeltaNextSparkConnection;
  readonly files: readonly PgDeltaNextSqlFile[];
}

/** A Spark plan, proven by replaying it on a scratch copy of the project. */
export interface PgDeltaNextSparkPlanResult {
  /** Rendered migration SQL; empty when there are no changes. */
  readonly sql: string;
  /** Messages for statements Spark rejects (`error`) or drops (`info`) in the schema files. */
  readonly diagnostics: readonly {
    readonly severity: "error" | "warning" | "info";
    readonly message: string;
  }[];
  readonly proof?: {
    readonly ok: boolean;
    readonly expected: string;
    readonly actual: string;
    readonly diagnostics: readonly { readonly severity: string; readonly message: string }[];
  };
}

export class PgDeltaNextError extends Data.TaggedError("PgDeltaNextError")<{
  readonly operation: PgDeltaNextOperation;
  readonly message: string;
  readonly cause: unknown;
  readonly diagnostics?: readonly PgDeltaErrorDiagnostic[];
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

export interface PgDeltaNextAdapterShape {
  readonly diff: (
    input: PgDeltaNextDiffInput,
  ) => Effect.Effect<PgDeltaNextDiffResult, PgDeltaNextError>;
  readonly exportDeclarativeSchema: (
    input: PgDeltaNextDeclarativeExportInput,
  ) => Effect.Effect<PgDeltaNextDeclarativeExportResult, PgDeltaNextError>;
  readonly planDeclarativeSchema: (
    input: PgDeltaNextDeclarativePlanInput,
  ) => Effect.Effect<PgDeltaNextDeclarativePlanResult, PgDeltaNextError>;
  readonly captureSnapshot: (
    input: PgDeltaNextSnapshotCaptureInput,
  ) => Effect.Effect<PgDeltaNextSnapshotCaptureResult, PgDeltaNextError>;
  /** Plans a Spark project toward declarative files and proves the plan on Spark scratch. */
  readonly planSparkSchema: (
    input: PgDeltaNextSparkPlanInput,
  ) => Effect.Effect<PgDeltaNextSparkPlanResult, PgDeltaNextError>;
  /** Declarative files, grouped layout, for a Spark project's live schema. */
  readonly exportSparkSchema: (
    connection: PgDeltaNextSparkConnection,
  ) => Effect.Effect<readonly PgDeltaNextSqlFile[], PgDeltaNextError>;
}

export class PgDeltaNextAdapter extends Context.Service<
  PgDeltaNextAdapter,
  PgDeltaNextAdapterShape
>()("supabase/cli/PgDeltaNextAdapter") {}
