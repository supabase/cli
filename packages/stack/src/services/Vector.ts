import { Effect, type FileSystem, type Path, Schema } from "effect";
import { ServiceError } from "../Service.ts";
import { type CatalogOptions, EndpointIntent, serviceCreation } from "./Recipe.ts";
import { requiredInput } from "./ServiceConfig.ts";
import {
  makeProcessRecipe,
  type ProcessDependencies,
  type ProcessRecipeSpec,
} from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  analyticsUrl: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
  /** Pipeline config without an `api` block; the recipe adds its own. */
  configPath: Schema.optionalKey(Schema.String),
});
export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });
export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("vector", Config, Endpoints);
export interface Creation extends Schema.Schema.Type<typeof Creation> {}

/**
 * Vector has no API flag or env var, so the recipe loads this alongside the pipeline config.
 * `address` is written into the file because Vector 0.58 disables `${VAR}` interpolation.
 */
const apiConfigFor = (address: string | undefined): string =>
  address === undefined
    ? "api:\n  enabled: false\n"
    : `api:\n  enabled: true\n  address: "${address}"\n`;

/**
 * Substitutes the recipe-owned `${VAR}` names a caller pipeline (`Config.configPath`) may use, so
 * it runs without `--dangerously-allow-env-var-interpolation`, which exposes every env var.
 */
const renderKnownPlaceholders = (
  content: string,
  values: Readonly<Record<string, string | undefined>>,
): string =>
  Object.entries(values).reduce(
    (rendered, [name, value]) =>
      value === undefined ? rendered : rendered.replaceAll(`\${${name}}`, value),
    content,
  );

// Vector requires at least one source and sink; the default forwards nothing.
const defaultPipelineConfig = [
  "sources:",
  "  vector_logs:",
  "    type: internal_logs",
  "sinks:",
  "  discard:",
  "    type: blackhole",
  "    inputs: [vector_logs]",
  "    print_interval_secs: 0",
  "",
].join("\n");

const containerPipelinePath = "/etc/vector/vector.yaml";
const containerApiPath = "/etc/supabase/vector-api.yaml";
const temporaryPrefix = ".vector-write-";

const writeAtomically = Effect.fn("Vector.writeAtomically")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, target: string, content: string) {
    const directory = path.dirname(target);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ directory, prefix: temporaryPrefix }),
      (temporaryDirectory) =>
        Effect.gen(function* () {
          const temporary = path.join(temporaryDirectory, path.basename(target));
          yield* fs.writeFileString(temporary, content, { mode: 0o644 });
          yield* fs.rename(temporary, target);
        }),
      (temporaryDirectory) =>
        fs
          .remove(temporaryDirectory, { recursive: true, force: true })
          .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
    );
  },
  Effect.mapError(
    (cause) =>
      new ServiceError({ operation: "prepare", message: "Unable to write Vector config", cause }),
  ),
);

const makeSpec = (
  instanceId: string,
  instanceRoot: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): ProcessRecipeSpec<Creation> => {
  const configRoot = path.join(instanceRoot, "runtime", "vector");
  const apiConfigPath = path.join(configRoot, "vector-api.yaml");
  const defaultPipelinePath = path.join(configRoot, "vector.yaml");
  const renderedPipelinePath = path.join(configRoot, "vector.rendered.yaml");
  /** What Vector actually loads: a caller's file is rendered to a recipe-owned copy first. */
  const resolvedPipelinePath = (creation: Creation) =>
    creation.config.configPath === undefined ? defaultPipelinePath : renderedPipelinePath;
  const ownedInstance = (operation: string) =>
    /^[a-zA-Z0-9_-]+$/u.test(instanceId)
      ? Effect.void
      : Effect.fail(new ServiceError({ operation, message: "Invalid Vector instance identity" }));
  return {
    service: "vector",
    executable: "bin/vector",
    ports: { http: 9001 },
    healthPath: "/health",
    env: (creation, _endpoints, _container) =>
      requiredInput("vector", "analyticsUrl", creation.config.analyticsUrl).pipe(
        Effect.map((analyticsUrl) => ({
          LOGFLARE_URL: analyticsUrl,
          ...(creation.config.apiKey === undefined
            ? {}
            : { LOGFLARE_PRIVATE_ACCESS_TOKEN: creation.config.apiKey }),
        })),
      ),
    args: (creation, endpoints, context) =>
      Effect.gen(function* () {
        const http = endpoints.get("http");
        const address =
          http === undefined
            ? undefined
            : `${context.container ? "0.0.0.0" : "127.0.0.1"}:${http.port}`;
        yield* writeAtomically(fs, path, apiConfigPath, apiConfigFor(address));
        if (creation.config.configPath !== undefined) {
          const source = yield* fs.readFileString(creation.config.configPath).pipe(
            Effect.mapError(
              (cause) =>
                new ServiceError({
                  operation: "prepare",
                  message: "Unable to read Vector configPath",
                  cause,
                }),
            ),
          );
          const rendered = renderKnownPlaceholders(source, {
            LOGFLARE_URL: creation.config.analyticsUrl,
            LOGFLARE_PRIVATE_ACCESS_TOKEN: creation.config.apiKey,
          });
          yield* writeAtomically(fs, path, renderedPipelinePath, rendered);
        }
        return context.container
          ? ["--config", containerPipelinePath, "--config", containerApiPath]
          : ["--config", resolvedPipelinePath(creation), "--config", apiConfigPath];
      }),
    mounts: (creation) =>
      Effect.succeed([
        { source: resolvedPipelinePath(creation), target: containerPipelinePath, readOnly: true },
        { source: apiConfigPath, target: containerApiPath, readOnly: true },
      ]),
    startupCommands: [],
    prepare: (creation) =>
      Effect.gen(function* () {
        yield* ownedInstance("prepare");
        const callerPath = creation.config.configPath;
        if (callerPath !== undefined) {
          const canonical = (file: string) =>
            fs
              .exists(file)
              .pipe(
                Effect.flatMap((exists) =>
                  exists ? fs.realPath(file) : Effect.succeed(path.resolve(file)),
                ),
              );
          const caller = yield* fs.realPath(callerPath).pipe(
            Effect.mapError(
              (cause) =>
                new ServiceError({
                  operation: "prepare",
                  message: "Unable to read Vector configPath",
                  cause,
                }),
            ),
          );
          const owned = yield* Effect.all([
            canonical(apiConfigPath),
            canonical(defaultPipelinePath),
            canonical(renderedPipelinePath),
          ]).pipe(
            Effect.mapError(
              (cause) =>
                new ServiceError({
                  operation: "prepare",
                  message: "Unable to resolve Vector config paths",
                  cause,
                }),
            ),
          );
          if (owned.includes(caller))
            return yield* new ServiceError({
              operation: "prepare",
              message: "Vector configPath must not point at a stack-owned Vector config file",
            });
        }
        // A safe placeholder until `args` writes the real address — the listening port isn't
        // known until endpoints are reserved for an actual launch, which happens after `prepare`.
        yield* writeAtomically(fs, path, apiConfigPath, apiConfigFor(undefined));
        if (callerPath === undefined)
          yield* writeAtomically(fs, path, defaultPipelinePath, defaultPipelineConfig);
      }),
    // A caller configPath may live anywhere under the instance root, so only recipe files and empty directories go.
    removeData: () =>
      Effect.gen(function* () {
        yield* ownedInstance("destroy");
        yield* fs.remove(apiConfigPath, { force: true });
        yield* fs.remove(defaultPipelinePath, { force: true });
        yield* fs.remove(renderedPipelinePath, { force: true });
        if (yield* fs.exists(configRoot))
          for (const entry of yield* fs.readDirectory(configRoot))
            if (entry.startsWith(temporaryPrefix))
              yield* fs.remove(path.join(configRoot, entry), { recursive: true, force: true });
        for (const directory of [configRoot, path.dirname(configRoot), instanceRoot]) {
          if (!(yield* fs.exists(directory))) continue;
          if ((yield* fs.readDirectory(directory)).length > 0) return;
          yield* fs.remove(directory, { recursive: true });
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ServiceError
            ? cause
            : new ServiceError({
                operation: "destroy",
                message: "Unable to remove Vector config",
                cause,
              }),
        ),
      ),
  };
};

export const makeRecipe = Effect.fn("Vector.makeRecipe")(
  (options: CatalogOptions, deps: ProcessDependencies) =>
    makeProcessRecipe(
      options,
      deps,
      makeSpec(
        options.instanceId,
        deps.path.join(options.root, options.instanceId),
        deps.fs,
        deps.path,
      ),
    ),
);
