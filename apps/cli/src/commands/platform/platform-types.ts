import type { Effect, Schema } from "effect";
import type {
  OperationDefinition,
  OperationId,
  SupabaseApiClient,
  SupabaseApiError,
} from "@supabase/api/effect";

export type PlatformHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type PlatformFieldLocation = "path" | "query" | "header" | "body";

export type PlatformFieldKind = "string" | "boolean" | "enum" | "unknown" | "array" | "object";

export type PlatformSchemaKind = PlatformFieldKind | "integer" | "number" | "union";

export type PlatformBodyKind = "none" | "json" | "binary" | "multipart" | "urlencoded";

export interface PlatformSchemaNode {
  readonly name?: string;
  readonly label?: string;
  readonly description?: string;
  readonly location?: PlatformFieldLocation;
  readonly kind: PlatformSchemaKind;
  readonly required: boolean;
  readonly nullable: boolean;
  readonly sensitive: boolean;
  readonly deprecated?: boolean;
  readonly format?: string;
  readonly enumValues?: ReadonlyArray<string>;
  readonly properties?: ReadonlyArray<PlatformSchemaNode>;
  readonly items?: PlatformSchemaNode;
  readonly variants?: ReadonlyArray<PlatformSchemaNode>;
}

export interface PlatformRequestBodyDescriptor {
  readonly kind: PlatformBodyKind;
  readonly contentType?: string;
  readonly schema?: PlatformSchemaNode;
  readonly fieldName?: string;
}

export interface PlatformInputHelpExample {
  readonly description: string;
  readonly command: string;
}

export interface PlatformInputHelpBody {
  readonly summary: string;
  readonly notes?: ReadonlyArray<string>;
  readonly examples?: ReadonlyArray<PlatformInputHelpExample>;
}

export interface PlatformInputHelp {
  readonly params?: string;
  readonly body?: PlatformInputHelpBody;
}

export interface PlatformGeneratedExamples {
  readonly inputHelp?: PlatformInputHelp;
  readonly commandExamples: ReadonlyArray<PlatformInputHelpExample>;
}

export interface PlatformOperationDescriptor {
  readonly operationId: OperationId;
  readonly commandPath: readonly [string, ...string[]];
  readonly method: PlatformHttpMethod;
  readonly path: string;
  readonly shortDescription: string;
  readonly description: string;
  readonly successMessage: string;
  readonly confirmsMutation: boolean;
  readonly inputSchema: Schema.Decoder<unknown, never>;
  readonly definition: OperationDefinition;
  readonly execute: (
    input: unknown,
  ) => Effect.Effect<unknown, PlatformOperationError, SupabaseApiClient>;
  readonly request: {
    readonly params: ReadonlyArray<PlatformSchemaNode>;
    readonly body: PlatformRequestBodyDescriptor;
  };
  readonly responseSchema?: PlatformSchemaNode;
}

export type PlatformOperationError = PlatformInputError | SupabaseApiError;

interface PlatformInputError {
  readonly _tag: "PlatformInputError";
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}
