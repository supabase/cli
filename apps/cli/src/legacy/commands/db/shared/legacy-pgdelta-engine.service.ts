import { Context, Data, type Effect } from "effect";

import type {
  LegacyDbConnectOptions,
  LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import type { LegacyPgDeltaContext } from "../../../shared/legacy-pgdelta.ts";
import type { LegacySetupInputs } from "../../../shared/legacy-pgdelta.cache.ts";
import type { LegacyPgDeltaImplementation } from "../../../shared/legacy-pgdelta-next-flag.ts";
import type { LegacyMigrationTransactionMode } from "../../../shared/legacy-migration-file.ts";
import type { LegacyDbTomlValues } from "../../../shared/legacy-db-config.toml-read.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export interface LegacyPgDeltaDatabaseEndpoint {
  readonly kind: "database";
  /** URL/reference used by the legacy edge-runtime implementation. */
  readonly ref: string;
  /** Full parsed connection, preferred by the next implementation. */
  readonly connection?: LegacyPgConnInput;
  readonly connectOptions: LegacyDbConnectOptions;
}

interface LegacyPgDeltaMigrationsEndpoint {
  readonly kind: "migrations";
  readonly projectRef?: string;
}

export type LegacyPgDeltaEndpoint = LegacyPgDeltaDatabaseEndpoint | LegacyPgDeltaMigrationsEndpoint;

export interface LegacyPgDeltaSqlFile {
  readonly name: string;
  readonly sql: string;
}

export interface LegacyPgDeltaExportManifest {
  readonly redactSecrets: boolean;
  readonly scope: "database" | "cluster";
  readonly profile?: string;
  readonly baselineDigest?: string;
  readonly defaultOwner?: string | null;
  readonly files?: ReadonlyArray<string>;
  readonly loadOrder?: ReadonlyArray<string>;
}

export interface LegacyPgDeltaRenderedFile {
  readonly sequence: number;
  /** Legacy semantic unit name. */
  readonly name: string;
  /** Next renderer's exact filename suffix (`null`, `_1`, `_2`, ...). */
  readonly suffix?: string | null;
  readonly sql: string;
  readonly transactionMode: LegacyMigrationTransactionMode;
  readonly actionCount?: number;
}

interface LegacyPgDeltaExtensionIntentRemoval {
  readonly extension: string;
  readonly intentKind: string;
  readonly key: string;
}

/** Root object removals retained from a semantic pg-delta plan. */
export interface LegacyPgDeltaRemovalSummary {
  readonly extensions: ReadonlyArray<string>;
  readonly extensionIntents: ReadonlyArray<LegacyPgDeltaExtensionIntentRemoval>;
}

export type LegacyPgDeltaHazardKind =
  | "data_loss"
  | "rewrite_risk"
  | "non_transactional"
  | "access_exclusive_lock"
  | "unmodeled_kind"
  | "unmodeled_drift"
  | "unresolved_security_label"
  | "vault_presence";

interface LegacyPgDeltaActionHazard {
  readonly actionIndex: number;
  readonly kinds: ReadonlyArray<LegacyPgDeltaHazardKind>;
}

interface LegacyPgDeltaDataLossAction {
  readonly actionIndex: number;
  readonly sql: string;
}

/** Semantic safety metadata derived from pg-delta's typed plan actions. */
export interface LegacyPgDeltaHazardReport {
  readonly actions: ReadonlyArray<LegacyPgDeltaActionHazard>;
  readonly dataLoss: ReadonlyArray<LegacyPgDeltaDataLossAction>;
  readonly coverage: ReadonlyArray<LegacyPgDeltaHazardKind>;
  readonly kinds: ReadonlyArray<LegacyPgDeltaHazardKind>;
}

interface LegacyPgDeltaDebugArtifacts {
  readonly sourceSnapshot?: string;
  readonly desiredSnapshot?: string;
  readonly plan?: string;
  readonly stderr?: string;
  /** Persisted debug directory, when the selected implementation writes one. */
  readonly directory?: string;
}

export interface LegacyPgDeltaDiffResult {
  readonly changes: boolean;
  readonly sql: string;
  readonly files: ReadonlyArray<LegacyPgDeltaRenderedFile>;
  readonly removals?: LegacyPgDeltaRemovalSummary;
  readonly hazards?: LegacyPgDeltaHazardReport;
  readonly debug?: LegacyPgDeltaDebugArtifacts;
}

interface LegacyPgDeltaCommonInput {
  readonly context: LegacyPgDeltaContext;
  readonly schema: ReadonlyArray<string>;
  readonly formatOptions: string;
  readonly projectRef?: string;
  readonly debug: boolean;
  /** Refuse coverage-gap diagnostics instead of continuing with those objects unmanaged. */
  readonly strictCoverage: boolean;
}

export interface LegacyPgDeltaExplicitDiffInput extends LegacyPgDeltaCommonInput {
  readonly source: LegacyPgDeltaEndpoint;
  readonly desired: LegacyPgDeltaEndpoint;
  /** Already-loaded config used when a migrations endpoint needs a native shadow. */
  readonly toml?: LegacyDbTomlValues;
}

export interface LegacyPgDeltaDatabaseDiffInput extends LegacyPgDeltaCommonInput {
  /** Workflow-owned, migrated shadow database. */
  readonly source: LegacyPgDeltaDatabaseEndpoint;
  readonly target: LegacyPgDeltaDatabaseEndpoint;
}

interface LegacyPgDeltaDeclarativeExportInput extends LegacyPgDeltaCommonInput {
  /** Workflow-owned empty shadow used only by the legacy declarative exporter. */
  readonly source?: LegacyPgDeltaDatabaseEndpoint;
  readonly target: LegacyPgDeltaDatabaseEndpoint;
  readonly noCache: boolean;
}

export interface LegacyPgDeltaDeclarativeExportResult {
  readonly files: ReadonlyArray<LegacyPgDeltaSqlFile>;
  readonly manifest?: LegacyPgDeltaExportManifest;
}

export interface LegacyPgDeltaDeclarativePlanInput extends LegacyPgDeltaCommonInput {
  readonly files: ReadonlyArray<LegacyPgDeltaSqlFile>;
  readonly manifest?: LegacyPgDeltaExportManifest;
  readonly noCache: boolean;
  /** Already-loaded config used by native shadow/catalog provisioning. */
  readonly toml: LegacyDbTomlValues;
  readonly setupInputs: LegacySetupInputs;
}

interface LegacyPgDeltaDeclarativePlanResult extends LegacyPgDeltaDiffResult {
  /** Debug labels retained for the legacy apply/reset bundle. */
  readonly sourceRef: string;
  readonly targetRef: string;
}

/** Engine-neutral diagnostic detail retained when an implementation reports a structured failure. */
export interface LegacyPgDeltaErrorDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export class LegacyPgDeltaEngineError extends Data.TaggedError("LegacyPgDeltaEngineError")<{
  readonly message: string;
  readonly cause: unknown;
  readonly suggestion?: string;
  readonly diagnostics?: readonly LegacyPgDeltaErrorDiagnostic[];
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

export interface LegacyPgDeltaEngineShape {
  readonly implementation: LegacyPgDeltaImplementation;
  readonly diffExplicit: (
    input: LegacyPgDeltaExplicitDiffInput,
  ) => Effect.Effect<LegacyPgDeltaDiffResult, LegacyPgDeltaEngineError>;
  readonly diffDatabase: (
    input: LegacyPgDeltaDatabaseDiffInput,
  ) => Effect.Effect<LegacyPgDeltaDiffResult, LegacyPgDeltaEngineError>;
  readonly exportDeclarativeSchema: (
    input: LegacyPgDeltaDeclarativeExportInput,
  ) => Effect.Effect<LegacyPgDeltaDeclarativeExportResult, LegacyPgDeltaEngineError>;
  readonly planDeclarativeSchema: (
    input: LegacyPgDeltaDeclarativePlanInput,
  ) => Effect.Effect<LegacyPgDeltaDeclarativePlanResult, LegacyPgDeltaEngineError>;
}

export class LegacyPgDeltaEngine extends Context.Service<
  LegacyPgDeltaEngine,
  LegacyPgDeltaEngineShape
>()("supabase/legacy/PgDeltaEngine") {}
