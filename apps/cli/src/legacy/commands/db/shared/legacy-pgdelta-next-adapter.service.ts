import type { Pool } from "pg";
import { Context, Data, type Effect } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import type { LegacyMigrationTransactionMode } from "../../../shared/legacy-migration-file.ts";
import type { LegacyPgDeltaRemovalSummary } from "./legacy-pgdelta-engine.service.ts";

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
  readonly redactSecrets?: boolean;
  readonly restrictToApplier?: boolean;
  readonly schema?: readonly string[];
  readonly formatOptions?: string;
}

interface LegacyPgDeltaNextDiffResult {
  readonly changes: boolean;
  readonly sql: string;
  readonly files: readonly LegacyPgDeltaNextRenderedFile[];
  readonly diagnostics: readonly LegacyPgDeltaNextDiagnostic[];
  readonly debug?: LegacyPgDeltaNextDebugArtifacts;
}

type LegacyPgDeltaNextManagementScope = "database" | "cluster";
type LegacyPgDeltaNextExportLayout = "by-object" | "ordered" | "grouped";

interface LegacyPgDeltaNextExportGroupingPattern {
  readonly pattern: string;
  readonly name: string;
}

interface LegacyPgDeltaNextExportGrouping {
  readonly mode?: "single-file" | "subdirectory";
  readonly groupPatterns?: readonly LegacyPgDeltaNextExportGroupingPattern[];
  readonly flatSchemas?: readonly string[];
  readonly autoGroupPartitions?: boolean;
}

export interface LegacyPgDeltaNextDeclarativeExportInput {
  readonly pool: Pool;
  readonly scope?: LegacyPgDeltaNextManagementScope;
  readonly redactSecrets?: boolean;
  readonly restrictToApplier?: boolean;
  readonly layout?: LegacyPgDeltaNextExportLayout;
  readonly grouping?: LegacyPgDeltaNextExportGrouping;
  readonly defaultOwner?: string | null;
  readonly onWarning?: (message: string) => void;
  readonly schema?: readonly string[];
  readonly formatOptions?: string;
}

export interface LegacyPgDeltaNextExportManifest {
  readonly redactSecrets: boolean;
  readonly scope: LegacyPgDeltaNextManagementScope;
  readonly profile?: string;
  readonly baselineDigest?: string;
  readonly defaultOwner?: string | null;
  readonly files?: readonly string[];
}

interface LegacyPgDeltaNextDeclarativeExportResult {
  readonly files: readonly LegacyPgDeltaNextSqlFile[];
  readonly manifest: LegacyPgDeltaNextExportManifest;
  readonly diagnostics: readonly LegacyPgDeltaNextDiagnostic[];
}

export interface LegacyPgDeltaNextDeclarativeManifestInput {
  readonly redactSecrets?: boolean;
  readonly profile?: string;
  readonly scope?: LegacyPgDeltaNextManagementScope;
  readonly baselineDigest?: string;
  readonly defaultOwner?: string | null;
  readonly files?: readonly string[];
}

export interface LegacyPgDeltaNextDeclarativePlanInput {
  readonly targetPool: Pool;
  readonly shadowPool: Pool;
  readonly files: readonly LegacyPgDeltaNextSqlFile[];
  readonly allowDrops: boolean;
  readonly debug: boolean;
  readonly scope?: LegacyPgDeltaNextManagementScope;
  readonly manifest?: LegacyPgDeltaNextDeclarativeManifestInput;
  readonly redactSecrets?: boolean;
  readonly skipClusterDdl?: boolean;
  readonly isolatedShadow?: boolean;
  readonly seedAssumedSchemas?: boolean;
  readonly restrictToApplier?: boolean;
  readonly strictFunctionBodies?: boolean;
  readonly formatOptions?: string;
  /** Defaults to true, preserving pg-topo statement-level reorder support. */
  readonly reorder?: boolean;
  readonly onWarning?: (message: string) => void;
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
  readonly skipped: readonly LegacyPgDeltaNextSkippedStatement[];
  readonly removals: LegacyPgDeltaRemovalSummary;
  readonly debug?: LegacyPgDeltaNextDebugArtifacts;
}

export interface LegacyPgDeltaNextSnapshotCaptureInput {
  readonly pool: Pool;
  readonly redactSecrets?: boolean;
  readonly statementTimeoutMs?: number;
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
