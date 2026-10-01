import { type Crypto, Effect, type FileSystem, type Path, Schema } from "effect";
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
const temporaryPrefix = ".vector-write-";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Matches only the content-addressed names this recipe itself generates in `configRoot`. */
const generatedConfigName = /^vector-(?:api|pipeline)-[0-9a-f]{16}\.yaml$/u;
const isGeneratedEntry = (name: string): boolean =>
  generatedConfigName.test(name) || name.startsWith(temporaryPrefix);

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

/** Writes `content` to a path named after its digest; unchanged content is not rewritten. */
const writeContentAddressed = Effect.fn("Vector.writeContentAddressed")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    crypto: Crypto.Crypto,
    configRoot: string,
    prefix: string,
    content: string,
  ) {
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(content));
    const target = path.join(configRoot, `${prefix}-${hex(digest).slice(0, 16)}.yaml`);
    if (!(yield* fs.exists(target))) yield* writeAtomically(fs, path, target, content);
    return target;
  },
  Effect.mapError((cause) =>
    cause instanceof ServiceError
      ? cause
      : new ServiceError({ operation: "launch", message: "Unable to write Vector config", cause }),
  ),
);

/** Removes stale recipe-generated files in `configRoot` except `keep`; a caller's own file never matches `isGeneratedEntry`. */
const pruneGenerated = Effect.fn("Vector.pruneGenerated")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    configRoot: string,
    keep: ReadonlySet<string>,
  ) {
    if (!(yield* fs.exists(configRoot))) return;
    for (const entry of yield* fs.readDirectory(configRoot)) {
      if (!isGeneratedEntry(entry)) continue;
      const full = path.join(configRoot, entry);
      if (keep.has(full)) continue;
      yield* fs.remove(full, { recursive: true, force: true });
    }
  },
  Effect.mapError(
    (cause) =>
      new ServiceError({ operation: "launch", message: "Unable to prune Vector config", cause }),
  ),
);

const makeSpec = (
  instanceId: string,
  instanceRoot: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
): ProcessRecipeSpec<Creation> => {
  const configRoot = path.join(instanceRoot, "runtime", "vector");
  const canonicalDirectory = (directory: string) =>
    fs
      .exists(directory)
      .pipe(
        Effect.flatMap((exists) =>
          exists ? fs.realPath(directory) : Effect.succeed(path.resolve(directory)),
        ),
      );
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
        const apiTarget = yield* writeContentAddressed(
          fs,
          path,
          crypto,
          configRoot,
          "vector-api",
          apiConfigFor(address),
        );
        const callerPath = creation.config.configPath;
        const pipelineTarget =
          callerPath === undefined
            ? yield* writeContentAddressed(
                fs,
                path,
                crypto,
                configRoot,
                "vector-pipeline",
                defaultPipelineConfig,
              )
            : yield* Effect.gen(function* () {
                const source = yield* fs.readFileString(callerPath).pipe(
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
                return yield* writeContentAddressed(
                  fs,
                  path,
                  crypto,
                  configRoot,
                  "vector-pipeline",
                  rendered,
                );
              });
        // Safe here: a previous generation's container is confirmed stopped by the time `args`
        // runs for a fresh launch; `prepare` can still run while that container is live.
        yield* pruneGenerated(fs, path, configRoot, new Set([apiTarget, pipelineTarget]));
        return context.container
          ? [
              "--config",
              `${containerConfigDir}/${path.basename(pipelineTarget)}`,
              "--config",
              `${containerConfigDir}/${path.basename(apiTarget)}`,
            ]
          : ["--config", pipelineTarget, "--config", apiTarget];
      }),
    mounts: () =>
      Effect.succeed([{ source: configRoot, target: containerConfigDir, readOnly: true }]),
    startupCommands: [],
    // Prefetches the default pipeline so a later start need not pay for it; `args` writes
    // independently and does not depend on this having run.
    prepare: (creation) =>
      Effect.gen(function* () {
        yield* ownedInstance("prepare");
        const callerPath = creation.config.configPath;
        if (callerPath !== undefined) {
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
          const ownedRoot = yield* canonicalDirectory(configRoot).pipe(
            Effect.mapError(
              (cause) =>
                new ServiceError({
                  operation: "prepare",
                  message: "Unable to resolve Vector config paths",
                  cause,
                }),
            ),
          );
          if (path.dirname(caller) === ownedRoot && isGeneratedEntry(path.basename(caller)))
            return yield* new ServiceError({
              operation: "prepare",
              message: "Vector configPath must not point at a stack-owned Vector config file",
            });
        } else {
          yield* writeContentAddressed(
            fs,
            path,
            crypto,
            configRoot,
            "vector-pipeline",
            defaultPipelineConfig,
          );
        }
      }),
    // A caller configPath may live anywhere under the instance root, including beside the
    // recipe's own files, so only generated files and resulting empty directories go.
    removeData: () =>
      Effect.gen(function* () {
        yield* ownedInstance("destroy");
        if (yield* fs.exists(configRoot))
          for (const entry of yield* fs.readDirectory(configRoot))
            if (isGeneratedEntry(entry))
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
        deps.crypto,
      ),
    ),
);
