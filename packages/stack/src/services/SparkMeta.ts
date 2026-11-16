import { NodeHttpServer } from "@effect/platform-node";
import { Deferred, Effect, Exit, FileSystem, Path, PubSub, Ref, Schema, Scope } from "effect";
import type { HttpClient } from "effect/http";
import { HttpServerRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer.make requires a native server factory.
import * as Http from "node:http";
import type { LaunchOutput } from "../runtime/Session.ts";
import { mapToServiceError } from "../runtime/Session.ts";
import type { RuntimeSession, ServiceDefinition } from "../Service.ts";
import {
  EndpointIntent,
  hostServiceCreation,
  type ProcessRecipeResult,
  type ServiceEndpoint,
} from "./Recipe.ts";
import { requiredInput } from "./ServiceConfig.ts";
import { makeSparkAdmin } from "./spark-meta/Admin.ts";
import { makeSparkMetaHandler } from "./spark-meta/Handler.ts";

export const Config = Schema.Struct({
  /** Spark's own API, which serves the admin routes the adapter reads. */
  sparkUrl: Schema.optionalKey(Schema.String),
  /** The public API URL clients use; it is the OpenAPI document's host. */
  publicUrl: Schema.optionalKey(Schema.String),
  anonKey: Schema.optionalKey(Schema.String),
  serviceRoleKey: Schema.optionalKey(Schema.String),
  /** Project directory; schema changes from Studio or MCP become files in its `supabase/migrations`. */
  projectRoot: Schema.String,
  /** The project ref the Management API routes answer for. */
  projectRef: Schema.optionalKey(Schema.String),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = hostServiceCreation("sparkmeta", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export interface SparkMetaDependencies {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly client: HttpClient.HttpClient;
}

/**
 * Serves Studio's pg-meta routes and the Management API subset MCP uses from Spark's schema
 * description, inside the stack owner: there is no Postgres for a pg-meta process to read.
 */
export const makeRecipe = (
  deps: SparkMetaDependencies,
): Effect.Effect<ProcessRecipeResult<Creation>> =>
  Effect.gen(function* () {
    const endpoints = yield* Ref.make<ReadonlyMap<string, ServiceEndpoint>>(new Map());
    const logs = yield* PubSub.sliding<LaunchOutput>(16);
    const definition: ServiceDefinition<Creation> = {
      launch: Effect.fn("SparkMeta.launch")(function* (context) {
        const { config } = context.config;
        const sparkUrl = yield* requiredInput("sparkmeta", "sparkUrl", config.sparkUrl);
        const serviceRoleKey = yield* requiredInput(
          "sparkmeta",
          "serviceRoleKey",
          config.serviceRoleKey,
        );
        const scope = yield* Scope.fork(context.scope, "sequential");
        const handler = yield* makeSparkMetaHandler(
          makeSparkAdmin(deps.client, sparkUrl, serviceRoleKey),
          {
            projectRef: config.projectRef ?? "default",
            publicUrl: config.publicUrl ?? sparkUrl,
            anonKey: config.anonKey ?? "",
            serviceRoleKey,
            migrationsDir: deps.path.join(config.projectRoot, "supabase", "migrations"),
            gapsFile: deps.path.join(config.projectRoot, "supabase", ".temp", "spark-gaps.jsonl"),
          },
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, deps.fs),
          Effect.provideService(Path.Path, deps.path),
        );
        const server = yield* NodeHttpServer.make(() => Http.createServer(), {
          host: "127.0.0.1",
          port: 0,
        }).pipe(
          Scope.provide(scope),
          Effect.mapError((cause) => mapToServiceError("launch", cause)),
        );
        if (!NetAddress.isInetAddress(server.address))
          return yield* mapToServiceError("launch", "Spark meta listener has no TCP address");
        const port = server.address.port;
        yield* server
          .serve(Effect.flatMap(HttpServerRequest.HttpServerRequest, handler))
          .pipe(Scope.provide(scope));
        yield* Ref.set(endpoints, new Map([["http", { kind: "tcp", host: "127.0.0.1", port }]]));
        yield* Effect.annotateCurrentSpan({ "spark_meta.port": port });
        const exited = yield* Deferred.make<Exit.Exit<void, never>>();
        const stop = Scope.close(scope, Exit.void).pipe(
          Effect.andThen(Deferred.succeed(exited, Exit.void)),
          Effect.asVoid,
        );
        return {
          health: Effect.void,
          exit: Deferred.await(exited),
          stop,
          remove: Ref.set(endpoints, new Map()),
        } satisfies RuntimeSession;
      }),
      removeData: () => Effect.void,
    };
    return { definition, endpoints, logs: PubSub.subscribe(logs) };
  });
