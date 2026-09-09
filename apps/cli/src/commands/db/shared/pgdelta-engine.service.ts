import { Context, Data, type Effect } from "effect";

import type {
  DbConnectOptions,
  PgConnInput,
} from "../../../command-internal/db-connection.service.ts";
import type { PgDeltaContext } from "../../../command-internal/pgdelta.ts";
import type { MigrationTransactionMode } from "../../../command-internal/migration-file.ts";
import type { DbTomlValues } from "../../../command-internal/db-config.toml-read.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

export interface PgDeltaDatabaseEndpoint {
  readonly kind: "database";
  /** Postgres connection URL; parsed when `connection` is absent. */
  readonly ref: string;
  /** Full parsed connection, preferred over parsing `ref`. */
  readonly connection?: PgConnInput;
  readonly connectOptions: DbConnectOptions;
}

interface PgDeltaMigrationsEndpoint {
  readonly kind: "migrations";
  readonly projectRef?: string;
}

export type PgDeltaEndpoint = PgDeltaDatabaseEndpoint | PgDeltaMigrationsEndpoint;

export interface PgDeltaSqlFile {
  readonly name: string;
  readonly sql: string;
}

export interface PgDeltaExportManifest {
  readonly redactSecrets: boolean;
  readonly scope: "database" | "cluster";
  readonly profile?: string;
  readonly baselineDigest?: string;
  readonly defaultOwner?: string | null;
  readonly files?: ReadonlyArray<string>;
  readonly loadOrder?: ReadonlyArray<string>;
}

export interface PgDeltaRenderedFile {
  readonly sequence: number;
  /** Legacy semantic unit name. */
  readonly name: string;
  /** Next renderer's exact filename suffix (`null`, `_1`, `_2`, ...). */
  readonly suffix?: string | null;
  readonly sql: string;
  readonly transactionMode: MigrationTransactionMode;
  readonly actionCount?: number;
}

interface PgDeltaExtensionIntentRemoval {
  readonly extension: string;
  readonly intentKind: string;
  readonly key: string;
}

/** Root object removals retained from a semantic pg-delta plan. */
export interface PgDeltaRemovalSummary {
  readonly extensions: ReadonlyArray<string>;
  readonly extensionIntents: ReadonlyArray<PgDeltaExtensionIntentRemoval>;
}

type PgDeltaHazardKind =
  | "data_loss"
  | "rewrite_risk"
  | "non_transactional"
  | "access_exclusive_lock"
  | "unmodeled_kind"
  | "unmodeled_drift"
  | "unresolved_security_label"
  | "vault_presence";

interface PgDeltaActionHazard {
  readonly actionIndex: number;
  readonly kinds: ReadonlyArray<PgDeltaHazardKind>;
}

interface PgDeltaDataLossAction {
  readonly actionIndex: number;
  readonly sql: string;
}

/** Semantic safety metadata derived from pg-delta's typed plan actions. */
export interface PgDeltaHazardReport {
  readonly actions: ReadonlyArray<PgDeltaActionHazard>;
  readonly dataLoss: ReadonlyArray<PgDeltaDataLossAction>;
  readonly coverage: ReadonlyArray<PgDeltaHazardKind>;
  readonly kinds: ReadonlyArray<PgDeltaHazardKind>;
}

interface PgDeltaDebugArtifacts {
  readonly sourceSnapshot?: string;
  readonly desiredSnapshot?: string;
  readonly plan?: string;
  readonly stderr?: string;
  /** Persisted debug directory, when the selected implementation writes one. */
  readonly directory?: string;
}

export interface PgDeltaDiffResult {
  readonly changes: boolean;
  readonly sql: string;
  readonly files: ReadonlyArray<PgDeltaRenderedFile>;
  readonly removals?: PgDeltaRemovalSummary;
  readonly hazards?: PgDeltaHazardReport;
  readonly debug?: PgDeltaDebugArtifacts;
}

interface PgDeltaCommonInput {
  readonly context: PgDeltaContext;
  readonly schema: ReadonlyArray<string>;
  readonly formatOptions: string;
  readonly projectRef?: string;
  readonly debug: boolean;
  /** Refuse coverage-gap diagnostics instead of continuing with those objects unmanaged. */
  readonly strictCoverage: boolean;
}

export interface PgDeltaExplicitDiffInput extends PgDeltaCommonInput {
  readonly source: PgDeltaEndpoint;
  readonly desired: PgDeltaEndpoint;
  /** Already-loaded config used when a migrations endpoint needs a native shadow. */
  readonly toml?: DbTomlValues;
}

export interface PgDeltaDatabaseDiffInput extends PgDeltaCommonInput {
  /** Workflow-owned, migrated shadow database. */
  readonly source: PgDeltaDatabaseEndpoint;
  readonly target: PgDeltaDatabaseEndpoint;
}

interface PgDeltaDeclarativeExportInput extends PgDeltaCommonInput {
  readonly target: PgDeltaDatabaseEndpoint;
}

export interface PgDeltaDeclarativeExportResult {
  readonly files: ReadonlyArray<PgDeltaSqlFile>;
  /** Ownership metadata the declarative writer records alongside the files. */
  readonly manifest: PgDeltaExportManifest;
}

export interface PgDeltaDeclarativePlanInput extends PgDeltaCommonInput {
  readonly files: ReadonlyArray<PgDeltaSqlFile>;
  readonly manifest?: PgDeltaExportManifest;
  readonly noCache: boolean;
  /** Already-loaded config used by native shadow/catalog provisioning. */
  readonly toml: DbTomlValues;
}

interface PgDeltaDeclarativePlanResult extends PgDeltaDiffResult {
  /** Debug labels retained for the legacy apply/reset bundle. */
  readonly sourceRef: string;
  readonly targetRef: string;
}

/** Engine-neutral diagnostic detail retained when an implementation reports a structured failure. */
export interface PgDeltaErrorDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export class PgDeltaEngineError extends Data.TaggedError("PgDeltaEngineError")<{
  readonly message: string;
  readonly cause: unknown;
  readonly suggestion?: string;
  readonly diagnostics?: readonly PgDeltaErrorDiagnostic[];
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

export interface PgDeltaEngineShape {
  readonly diffExplicit: (
    input: PgDeltaExplicitDiffInput,
  ) => Effect.Effect<PgDeltaDiffResult, PgDeltaEngineError>;
  readonly diffDatabase: (
    input: PgDeltaDatabaseDiffInput,
  ) => Effect.Effect<PgDeltaDiffResult, PgDeltaEngineError>;
  readonly exportDeclarativeSchema: (
    input: PgDeltaDeclarativeExportInput,
  ) => Effect.Effect<PgDeltaDeclarativeExportResult, PgDeltaEngineError>;
  readonly planDeclarativeSchema: (
    input: PgDeltaDeclarativePlanInput,
  ) => Effect.Effect<PgDeltaDeclarativePlanResult, PgDeltaEngineError>;
}

export class PgDeltaEngine extends Context.Service<PgDeltaEngine, PgDeltaEngineShape>()(
  "supabase/cli/PgDeltaEngine",
) {}
