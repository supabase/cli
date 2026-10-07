import { Data, Schema } from "effect";
import type { Effect, PubSub, Ref, Scope } from "effect";
import type { ServiceKind } from "../Artifacts.ts";
import type { LaunchOutput } from "../runtime/Session.ts";
import type { ServiceDefinition } from "../Service.ts";
import type { EngineTarget, HostGateway } from "../runtime/Container.ts";
import type { DockerHelperRegistry } from "../storage/DockerHelperRegistry.ts";

type CatalogRuntime = "native" | "docker" | "podman";

export class CatalogError extends Data.TaggedError("CatalogError")<{
  readonly operation: string;
  readonly message: string;
  readonly service?: ServiceKind;
  readonly cause?: unknown;
}> {}

export type ServiceEndpoint =
  | { readonly kind: "tcp"; readonly host?: "127.0.0.1"; readonly port: number }
  /** `path` is the full socket filename, for example `<dir>/.s.PGSQL.<port>`. */
  | { readonly kind: "unix"; readonly path: string; readonly port: number };

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
  /** Project folder name; the container runtime sanitizes it into names and grouping labels. */
  readonly project?: string;
  readonly root: string;
  readonly cacheRoot: string;
  readonly runtime: CatalogRuntime;
  readonly platform?: { readonly os: string; readonly arch: string };
  /** Reuses one volume helper across databases in this host. */
  readonly helpers?: DockerHelperRegistry;
  /** Shares one host-gateway probe across this host's container runtimes. */
  readonly hostGateway?: HostGateway;
  /** The engine endpoint and identity the owner resolved once at startup; absent when native. */
  readonly engineTarget?: EngineTarget;
}

/** Subscribes to a recipe's launch output; chunks published before the subscription are missed. */
export type CatalogLogs = Effect.Effect<PubSub.Subscription<LaunchOutput>, never, Scope.Scope>;

export interface CatalogRecipe<C> {
  readonly creation: C;
  readonly definition: ServiceDefinition<C>;
  readonly endpoint: (name: string) => Effect.Effect<ServiceEndpoint, CatalogError>;
  readonly logs: CatalogLogs;
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
  readonly logs: CatalogLogs;
}
