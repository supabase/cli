import { Data, Schema } from "effect";
import type { Stream } from "effect";
import type { Effect, Ref } from "effect";
import type { ServiceKind } from "../Artifacts.ts";
import type { ServiceDefinition } from "../Service.ts";

type CatalogRuntime = "native" | "docker" | "podman";

export class CatalogError extends Data.TaggedError("CatalogError")<{
  readonly operation: string;
  readonly message: string;
  readonly service?: ServiceKind;
  readonly cause?: unknown;
}> {}

export interface ServiceEndpoint {
  readonly kind: "tcp" | "unix";
  readonly host?: "127.0.0.1";
  readonly path?: string;
  readonly port: number;
}

export const EndpointIntent = Schema.Struct({
  port: Schema.Union([Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), Schema.Literal("auto")]),
});
export interface EndpointIntent extends Schema.Schema.Type<typeof EndpointIntent> {}

export const serviceCreation = <
  K extends ServiceKind,
  C extends Schema.Schema<unknown>,
  E extends Schema.Schema<unknown>,
>(
  service: K,
  config: C,
  endpoints: E,
) =>
  Schema.Struct({
    service: Schema.Literal(service),
    version: Schema.optionalKey(Schema.String),
    config,
    endpoints: Schema.optionalKey(endpoints),
  });

export interface CatalogOptions {
  readonly stackId: string;
  readonly instanceId: string;
  readonly root: string;
  readonly cacheRoot: string;
  readonly runtime: CatalogRuntime;
  readonly platform?: { readonly os: string; readonly arch: string };
}

export interface CatalogLog {
  readonly stream: "stdout" | "stderr";
  readonly bytes: Uint8Array;
}

export interface CatalogRecipe<C> {
  readonly creation: C;
  readonly definition: ServiceDefinition<C>;
  readonly endpoint: (name: string) => Effect.Effect<ServiceEndpoint, CatalogError>;
  readonly logs: Stream.Stream<CatalogLog, CatalogError>;
}

export interface RecipeCreation<K extends ServiceKind, C> {
  readonly service: K;
  readonly version?: string;
  readonly config: C;
  readonly endpoints?: unknown;
}

export interface ProcessRecipeResult<C> {
  readonly definition: ServiceDefinition<C>;
  readonly endpoints: Ref.Ref<ReadonlyMap<string, ServiceEndpoint>>;
  readonly logs: Stream.Stream<CatalogLog, CatalogError>;
}
