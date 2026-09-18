import { Crypto, Effect, FileSystem, Path, Ref, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { makeContainerRuntime } from "../runtime/Container.ts";
import { ServiceError, type ServiceDefinition } from "../Service.ts";
import {
  makeDatabase,
  DatabaseConfig,
  DatabaseCreation,
  DatabaseEndpoints,
  type DatabaseComponent,
} from "./Database.ts";
import * as Analytics from "./Analytics.ts";
import * as Auth from "./Auth.ts";
import * as Functions from "./Functions.ts";
import * as Imgproxy from "./Imgproxy.ts";
import * as Mail from "./Mail.ts";
import * as Pgmeta from "./Pgmeta.ts";
import * as Pooler from "./Pooler.ts";
import * as Realtime from "./Realtime.ts";
import * as Rest from "./Rest.ts";
import * as Storage from "./Storage.ts";
import * as Studio from "./Studio.ts";
import * as Vector from "./Vector.ts";
import {
  CatalogError,
  type CatalogOptions,
  type CatalogRecipe as RecipeCatalogRecipe,
  type ProcessRecipeResult,
} from "./Recipe.ts";
import { makeProcessRecipe, type ProcessDependencies } from "./ProcessRecipe.ts";
import type { ServiceKind } from "../Artifacts.ts";

export type { CatalogLog } from "./Recipe.ts";

const endpointSchemas = [
  ["database", DatabaseEndpoints],
  ["rest", Rest.Endpoints],
  ["auth", Auth.Endpoints],
  ["realtime", Realtime.Endpoints],
  ["storage", Storage.Endpoints],
  ["imgproxy", Imgproxy.Endpoints],
  ["functions", Functions.Endpoints],
  ["studio", Studio.Endpoints],
  ["pgmeta", Pgmeta.Endpoints],
  ["mail", Mail.Endpoints],
  ["analytics", Analytics.Endpoints],
  ["vector", Vector.Endpoints],
  ["pooler", Pooler.Endpoints],
] as const;

export const allowedEndpointNames = (kind: ServiceKind): ReadonlyArray<string> => {
  const schema = endpointSchemas.find(([service]) => service === kind)?.[1];
  return schema === undefined ? [] : Object.keys(schema.fields);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateEndpointNames = (input: unknown): CatalogError | undefined => {
  if (!isRecord(input) || typeof input.service !== "string" || !isRecord(input.endpoints))
    return undefined;
  const entry = endpointSchemas.find(([service]) => service === input.service);
  if (entry === undefined) return undefined;
  const invalid = Object.keys(input.endpoints).find(
    (name) => !Object.keys(entry[1].fields).includes(name),
  );
  return invalid === undefined
    ? undefined
    : new CatalogError({
        operation: "config",
        message: `Endpoint ${invalid} is not supported by service ${input.service}`,
      });
};

export const ServiceCreation = Schema.Union([
  DatabaseCreation,
  Rest.Creation,
  Auth.Creation,
  Realtime.Creation,
  Storage.Creation,
  Imgproxy.Creation,
  Functions.Creation,
  Studio.Creation,
  Pgmeta.Creation,
  Mail.Creation,
  Analytics.Creation,
  Vector.Creation,
  Pooler.Creation,
]);
export type ServiceCreation = Schema.Schema.Type<typeof ServiceCreation>;
export const serviceSchemas = {
  database: DatabaseConfig,
  rest: Rest.Config,
  auth: Auth.Config,
  realtime: Realtime.Config,
  storage: Storage.Config,
  imgproxy: Imgproxy.Config,
  functions: Functions.Config,
  studio: Studio.Config,
  pgmeta: Pgmeta.Config,
  mail: Mail.Config,
  analytics: Analytics.Config,
  vector: Vector.Config,
  pooler: Pooler.Config,
} as const;

const serviceError = (operation: string, cause: unknown) =>
  new ServiceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const widen = <C extends { readonly service: ServiceKind }>(
  isCreation: (value: unknown) => value is C,
  definition: ServiceDefinition<C>,
): ServiceDefinition<ServiceCreation> => ({
  prepare: (candidate) =>
    isCreation(candidate)
      ? (definition.prepare?.(candidate) ?? Effect.void)
      : Effect.fail(serviceError("prepare", "Service kind cannot change during restart")),
  launch: (context) =>
    isCreation(context.config)
      ? definition.launch({ ...context, config: context.config })
      : Effect.fail(serviceError("launch", "Service kind cannot change during restart")),
  removeData: (context) =>
    isCreation(context.config)
      ? definition.removeData({ ...context, config: context.config })
      : Effect.fail(serviceError("destroy", "Service kind cannot change during restart")),
});

const catalogRecipe = <C extends ServiceCreation>(
  creation: C,
  result: ProcessRecipeResult<C>,
  isCreation: (value: unknown) => value is C,
): RecipeCatalogRecipe<ServiceCreation> => ({
  creation,
  definition: widen(isCreation, result.definition),
  endpoint: (name) =>
    Ref.get(result.endpoints).pipe(
      Effect.flatMap((endpoints) => {
        const endpoint = endpoints.get(name);
        return endpoint === undefined
          ? Effect.fail(
              new CatalogError({
                operation: "endpoint",
                message: `Endpoint ${name} is not running`,
                service: creation.service,
              }),
            )
          : Effect.succeed(endpoint);
      }),
    ),
  logs: result.logs,
});

const databaseRecipe = (
  creation: Schema.Schema.Type<typeof DatabaseCreation>,
  component: DatabaseComponent,
): RecipeCatalogRecipe<ServiceCreation> => ({
  creation,
  definition: {
    prepare: (candidate) =>
      candidate.service === "database"
        ? (component.definition.prepare?.(candidate.config) ?? Effect.void)
        : Effect.fail(serviceError("prepare", "Service kind cannot change during restart")),
    launch: (context) =>
      context.config.service === "database"
        ? component.definition.launch({ ...context, config: context.config.config })
        : Effect.fail(serviceError("launch", "Service kind cannot change during restart")),
    removeData: (context) =>
      context.config.service === "database"
        ? component.definition.removeData({ ...context, config: context.config.config })
        : Effect.fail(serviceError("destroy", "Service kind cannot change during restart")),
  },
  endpoint: (name) =>
    name === "sql"
      ? component.endpoint.pipe(
          Effect.mapError(
            (cause) =>
              new CatalogError({
                operation: "endpoint",
                message: cause.message,
                service: "database",
                cause,
              }),
          ),
        )
      : Effect.fail(
          new CatalogError({
            operation: "endpoint",
            message: `Unknown endpoint ${name}`,
            service: "database",
          }),
        ),
  logs: component.logs.pipe(
    Stream.mapError(
      (cause) =>
        new CatalogError({ operation: "logs", message: cause.message, service: "database", cause }),
    ),
  ),
});

export const makeServiceRecipe = Effect.fn("Catalog.makeServiceRecipe")(
  (input: unknown, options: CatalogOptions) =>
    Effect.gen(function* () {
      const endpointError = validateEndpointNames(input);
      if (endpointError !== undefined) return yield* endpointError;
      if (isRecord(input) && input.service === "database" && input.version !== undefined)
        return yield* new CatalogError({
          operation: "config",
          message: "Database artifact version belongs in config.version",
          service: "database",
        });
      const creation = yield* Schema.decodeUnknownEffect(ServiceCreation)(input).pipe(
        Effect.mapError(
          (cause) =>
            new CatalogError({ operation: "config", message: "Invalid service creation", cause }),
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const client = yield* HttpClient.HttpClient;
      if (creation.service === "database") {
        const component = yield* makeDatabase({
          stackId: options.stackId,
          instanceId: options.instanceId,
          root: options.root,
          cacheRoot: options.cacheRoot,
          runtime: options.runtime,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CatalogError({
                operation: "database",
                message: cause.message,
                service: "database",
                cause,
              }),
          ),
        );
        return databaseRecipe(creation, component);
      }
      const container =
        options.runtime === "native"
          ? undefined
          : yield* makeContainerRuntime({ engine: options.runtime });
      const deps: ProcessDependencies = { fs, path, crypto, client, spawner, container };
      switch (creation.service) {
        case "rest":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Rest.makeSpec()),
            Schema.is(Rest.Creation),
          );
        case "auth":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Auth.makeSpec()),
            Schema.is(Auth.Creation),
          );
        case "realtime":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Realtime.makeSpec()),
            Schema.is(Realtime.Creation),
          );
        case "storage":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Storage.makeSpec()),
            Schema.is(Storage.Creation),
          );
        case "imgproxy":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Imgproxy.makeSpec()),
            Schema.is(Imgproxy.Creation),
          );
        case "functions":
          return catalogRecipe(
            creation,
            yield* Functions.makeRecipe(creation, options, deps),
            Schema.is(Functions.Creation),
          );
        case "studio":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Studio.makeSpec()),
            Schema.is(Studio.Creation),
          );
        case "pgmeta":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Pgmeta.makeSpec()),
            Schema.is(Pgmeta.Creation),
          );
        case "mail":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Mail.makeSpec()),
            Schema.is(Mail.Creation),
          );
        case "analytics":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Analytics.makeSpec()),
            Schema.is(Analytics.Creation),
          );
        case "vector":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Vector.makeSpec()),
            Schema.is(Vector.Creation),
          );
        case "pooler":
          return catalogRecipe(
            creation,
            yield* makeProcessRecipe(creation, options, deps, Pooler.makeSpec()),
            Schema.is(Pooler.Creation),
          );
      }
    }),
);

export type CatalogRecipe = RecipeCatalogRecipe<ServiceCreation>;
