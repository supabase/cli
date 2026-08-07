import { Context, Data, type Effect } from "effect";

import type {
  LegacyDbConnectOptions,
  LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import type { LegacyPgDeltaContext } from "../../../shared/legacy-pgdelta.ts";
import type { LegacySetupInputs } from "../../../shared/legacy-pgdelta.cache.ts";
import type { LegacyPgDeltaImplementation } from "../../../shared/legacy-pgdelta-next-flag.ts";

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
}

export type LegacyPgDeltaTransactionMode = "transactional" | "none";

export interface LegacyPgDeltaRenderedFile {
  readonly sequence: number;
  /** Legacy semantic unit name. */
  readonly name: string;
  /** Next renderer's exact filename suffix (`null`, `_1`, `_2`, ...). */
  readonly suffix?: string | null;
  readonly sql: string;
  readonly transactionMode: LegacyPgDeltaTransactionMode;
  readonly actionCount?: number;
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
  readonly debug?: LegacyPgDeltaDebugArtifacts;
}

interface LegacyPgDeltaCommonInput {
  readonly context: LegacyPgDeltaContext;
  readonly schema: ReadonlyArray<string>;
  readonly formatOptions: string;
  readonly projectRef?: string;
  readonly debug: boolean;
}

export interface LegacyPgDeltaExplicitDiffInput extends LegacyPgDeltaCommonInput {
  readonly source: LegacyPgDeltaEndpoint;
  readonly desired: LegacyPgDeltaEndpoint;
}

export interface LegacyPgDeltaDatabaseDiffInput extends LegacyPgDeltaCommonInput {
  readonly target: LegacyPgDeltaDatabaseEndpoint;
}

interface LegacyPgDeltaDeclarativeExportInput extends LegacyPgDeltaCommonInput {
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
  readonly setupInputs: LegacySetupInputs;
}

interface LegacyPgDeltaDeclarativePlanResult extends LegacyPgDeltaDiffResult {
  /** Debug labels retained for the legacy apply/reset bundle. */
  readonly sourceRef: string;
  readonly targetRef: string;
}

export class LegacyPgDeltaEngineError extends Data.TaggedError("LegacyPgDeltaEngineError")<{
  readonly message: string;
  readonly cause: unknown;
  readonly suggestion?: string;
}> {}

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
