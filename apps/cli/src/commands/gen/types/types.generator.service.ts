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
  /**
   * Registry option values keyed by option name: the language flags the user set plus the
   * consumer settings the CLI derives itself (`detect-one-to-one-relationships`). Names the
   * chosen language does not declare are dropped before generation, so every path passes the
   * full set.
   */
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

/**
 * The toolchain or package an out-of-process language runs (for example `dart` and the
 * `supabase_typegen` package for `--lang dart`) is not available in the working directory.
 * `suggestion` carries the registry's install hint.
 */
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

/**
 * An out-of-process language's tool exited unsuccessfully or rejected the metadata document;
 * the message carries the tool's own stderr.
 */
export class GenTypesToolFailedError extends Data.TaggedError("GenTypesToolFailedError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.toolFailed;
  }
}

/**
 * Generates PostgREST client types through the `@supabase/typegen` registry: introspection runs
 * in-process, then the language's registry entry either calls its generator in-process or runs
 * the language's own tool in the working directory.
 */
export class GenTypesGenerator extends Context.Service<GenTypesGenerator, GenTypesGeneratorShape>()(
  "supabase/cli/GenTypesGenerator",
) {}
