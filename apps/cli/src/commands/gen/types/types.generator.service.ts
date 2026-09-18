import { Context, Data, type Effect, type Scope } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import type { DbConnectError } from "../../../command-internal/db-connection.errors.ts";
import type {
  DbConnectOptions,
  PgConnInput,
} from "../../../command-internal/db-connection.service.ts";

/** Output language `gen types` can produce, mirroring the `@supabase/postgrest-typegen` generators. */
type GenTypesLanguage = "typescript" | "go" | "python" | "swift";

/**
 * Swift access-control levels `gen types` exposes. The underlying generator also accepts
 * `"private"`/`"package"`, which this command does not surface.
 */
type GenTypesSwiftAccessControl = "internal" | "public";

export interface GenTypesGenerateInput {
  readonly conn: PgConnInput;
  readonly isLocal: boolean;
  readonly dnsResolver: DbConnectOptions["dnsResolver"];
  readonly lang: GenTypesLanguage;
  readonly includedSchemas: ReadonlyArray<string>;
  readonly detectOneToOneRelationships: boolean;
  readonly swiftAccessControl: GenTypesSwiftAccessControl;
}

interface GenTypesGeneratorShape {
  /** Connects to `input.conn`, introspects it, and generates `input.lang` source. */
  readonly generate: (
    input: GenTypesGenerateInput,
  ) => Effect.Effect<string, GenTypesGenerationError | DbConnectError, Scope.Scope>;
}

/** Introspection or code generation failed against the target database's schema. */
export class GenTypesGenerationError extends Data.TaggedError("GenTypesGenerationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * Generates PostgREST client types in-process via `@supabase/postgrest-typegen`, replacing the
 * pg-meta Docker container `gen types` previously shelled out to.
 */
export class GenTypesGenerator extends Context.Service<GenTypesGenerator, GenTypesGeneratorShape>()(
  "supabase/cli/GenTypesGenerator",
) {}
