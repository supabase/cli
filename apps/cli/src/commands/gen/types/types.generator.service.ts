import type { OptionValues } from "@supabase/typegen";
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

export interface GenTypesGenerateInput {
  readonly conn: PgConnInput;
  readonly isLocal: boolean;
  readonly dnsResolver: DbConnectOptions["dnsResolver"];
  /** A `--lang` value: the name of one of the registry's `languages`. */
  readonly lang: string;
  readonly includedSchemas: ReadonlyArray<string>;
  /** Registry option values by name; ones the language does not declare are dropped. */
  readonly options: OptionValues;
}

export type GenTypesGenerateError =
  | GenTypesGenerationError
  | GenTypesToolNotInstalledError
  | GenTypesToolFailedError;

interface GenTypesGeneratorShape {
  /** Connects to `input.conn`, introspects it, and generates `input.lang` source. */
  readonly generate: (
    input: GenTypesGenerateInput,
  ) => Effect.Effect<string, GenTypesGenerateError | DbConnectError, Scope.Scope>;
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

/** An out-of-process language's toolchain is missing; `suggestion` carries the install hint. */
export class GenTypesToolNotInstalledError extends Data.TaggedError(
  "GenTypesToolNotInstalledError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.toolNotInstalled;
  }
}

/** An out-of-process language's tool failed; the message carries its stderr. */
export class GenTypesToolFailedError extends Data.TaggedError("GenTypesToolFailedError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.toolFailed;
  }
}

/** Introspects the target database and generates `lang` through the `@supabase/typegen` registry. */
export class GenTypesGenerator extends Context.Service<GenTypesGenerator, GenTypesGeneratorShape>()(
  "supabase/cli/GenTypesGenerator",
) {}
