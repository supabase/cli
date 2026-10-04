import { type Crypto, Effect, type FileSystem, type Path, Schema } from "effect";
import { contentDigestHex } from "../internal/content-digest.ts";
import { publishGeneration } from "../internal/generation-publish.ts";
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

/** Fixed mount point for `configRoot`; `args` names the generation to load underneath it. */
const containerConfigDir = "/etc/supabase/vector";
const apiFileName = "vector-api.yaml";
const pipelineFileName = "vector-pipeline.yaml";
const generationPrefix = "generation-";

const makeSpec = (
  instanceRoot: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
): ProcessRecipeSpec<Creation> => {
  const configRoot = path.join(instanceRoot, "runtime", "vector");
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
        const apiContent = apiConfigFor(address);
        const callerPath = creation.config.configPath;
        const pipelineContent =
          callerPath === undefined
            ? defaultPipelineConfig
            : yield* fs.readFileString(callerPath).pipe(
                Effect.map((source) =>
                  renderKnownPlaceholders(source, {
                    LOGFLARE_URL: creation.config.analyticsUrl,
                    LOGFLARE_PRIVATE_ACCESS_TOKEN: creation.config.apiKey,
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new ServiceError({
                      operation: "launch",
                      message: "Unable to read Vector configPath",
                      cause,
                    }),
                ),
              );
        // Both files publish together under one generation name, so a fresh container only ever
        // bind-mounts a directory that has never been deleted before. Length-prefixing the first
        // part avoids any ambiguity from concatenating the two strings directly.
        const generation = yield* contentDigestHex(
          crypto,
          `${apiContent.length}:${apiContent}${pipelineContent}`,
        ).pipe(
          Effect.flatMap((hash) =>
            publishGeneration(fs, path, configRoot, `${generationPrefix}${hash}`, [
              { name: apiFileName, content: apiContent, mode: 0o644 },
              { name: pipelineFileName, content: pipelineContent, mode: 0o644 },
            ]),
          ),
          Effect.mapError(
            (cause) =>
              new ServiceError({
                operation: "launch",
                message: "Unable to write Vector config",
                cause,
              }),
          ),
        );
        return context.container
          ? [
              "--config",
              `${containerConfigDir}/${path.basename(generation)}/${pipelineFileName}`,
              "--config",
              `${containerConfigDir}/${path.basename(generation)}/${apiFileName}`,
            ]
          : [
              "--config",
              path.join(generation, pipelineFileName),
              "--config",
              path.join(generation, apiFileName),
            ];
      }),
    mounts: () =>
      Effect.succeed([{ source: configRoot, target: containerConfigDir, readOnly: true }]),
    startupCommands: [],
    // No removeData: configRoot lives under instanceRoot, which ProcessRecipe's destroyOwnedRoot
    // already removes recursively; a caller's borrowed config sits outside it by construction,
    // validated by callerPaths against the whole stack data root, not just this instance root.
    callerPaths: (creation) =>
      creation.config.configPath === undefined ? [] : [creation.config.configPath],
  };
};

export const makeRecipe = Effect.fn("Vector.makeRecipe")(
  (creation: Creation, options: CatalogOptions, deps: ProcessDependencies) =>
    makeProcessRecipe(
      creation,
      options,
      deps,
      makeSpec(deps.path.join(options.root, options.instanceId), deps.fs, deps.path, deps.crypto),
    ),
);
