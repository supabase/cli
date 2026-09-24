import { Effect, type FileSystem, type Path, Schema } from "effect";
import { ServiceError } from "../Service.ts";
import { type CatalogOptions, EndpointIntent, serviceCreation } from "./Recipe.ts";
import {
  makeProcessRecipe,
  type ProcessDependencies,
  type ProcessRecipeSpec,
} from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  analyticsUrl: Schema.String,
  apiKey: Schema.optionalKey(Schema.String),
  /** Pipeline config without an `api` block; the recipe adds its own and Vector rejects a different address. */
  configPath: Schema.optionalKey(Schema.String),
});
export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });
export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("vector", Config, Endpoints);
export interface Creation extends Schema.Schema.Type<typeof Creation> {}

// Vector has no API flag or env var, so the recipe loads this alongside the pipeline config.
const apiConfig = 'api:\n  enabled: true\n  address: "${VECTOR_API_ADDRESS}"\n';

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

const writeAtomically = Effect.fn("Vector.writeAtomically")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, target: string, content: string) {
    const directory = path.dirname(target);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ directory, prefix: ".vector-write-" }),
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
  const pipelinePath = (creation: Creation) => creation.config.configPath ?? defaultPipelinePath;
  const ownedInstance = (operation: string) =>
    /^[a-zA-Z0-9_-]+$/u.test(instanceId)
      ? Effect.void
      : Effect.fail(new ServiceError({ operation, message: "Invalid Vector instance identity" }));
  return {
    service: "vector",
    executable: "bin/vector",
    ports: { http: 9001 },
    healthPath: "/health",
    env: (creation, endpoints, container) => {
      const http = endpoints.get("http");
      return Effect.succeed({
        ...(http === undefined
          ? {}
          : { VECTOR_API_ADDRESS: `${container ? "0.0.0.0" : "127.0.0.1"}:${http.port}` }),
        LOGFLARE_URL: creation.config.analyticsUrl,
        ...(creation.config.apiKey === undefined
          ? {}
          : { LOGFLARE_PRIVATE_ACCESS_TOKEN: creation.config.apiKey }),
      });
    },
    args: (creation, _endpoints, context) =>
      Effect.succeed(
        context.container
          ? ["--config", containerPipelinePath, "--config", containerApiPath]
          : ["--config", pipelinePath(creation), "--config", apiConfigPath],
      ),
    mounts: (creation) =>
      Effect.succeed([
        { source: pipelinePath(creation), target: containerPipelinePath, readOnly: true },
        { source: apiConfigPath, target: containerApiPath, readOnly: true },
      ]),
    startup: [],
    prepare: (creation) =>
      Effect.gen(function* () {
        yield* ownedInstance("prepare");
        yield* writeAtomically(fs, path, apiConfigPath, apiConfig);
        if (creation.config.configPath === undefined)
          yield* writeAtomically(fs, path, defaultPipelinePath, defaultPipelineConfig);
      }),
    // A caller configPath may live anywhere under the instance root, so only recipe files and empty directories go.
    removeData: () =>
      Effect.gen(function* () {
        yield* ownedInstance("destroy");
        yield* fs.remove(apiConfigPath, { force: true });
        yield* fs.remove(defaultPipelinePath, { force: true });
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
  (creation: Creation, options: CatalogOptions, deps: ProcessDependencies) =>
    makeProcessRecipe(
      creation,
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
