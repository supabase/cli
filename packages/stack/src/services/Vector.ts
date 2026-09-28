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

// Vector has no API flag or env var, so the recipe loads this alongside the pipeline config.
const apiConfig = 'api:\n  enabled: true\n  address: "${VECTOR_API_ADDRESS}"\n';

// Vector requires at least one source and sink; native service output stays in stack memory, so
// the native default forwards nothing.
const nativePipelineConfig = [
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

const logflareSources = {
  auth: "gotrue.logs.prod",
  rest: "postgREST.logs.prod",
  realtime: "realtime.logs.prod",
  storage: "storage.logs.prod.2",
  functions: "deno-relay-logs",
  database: "postgres.logs",
} as const;

const serviceTransforms: Record<keyof typeof logflareSources, ReadonlyArray<string>> = {
  auth: [
    "parsed, err = parse_json(.event_message)",
    "if err == null {",
    "  .metadata.timestamp = parsed.time",
    "  .metadata = merge!(.metadata, parsed)",
    "}",
  ],
  rest: [
    "parsed, err = parse_regex(.event_message, r'^(?P<time>.*): (?P<msg>.*)$')",
    "if err == null {",
    "  .event_message = parsed.msg",
    '  .timestamp = parse_timestamp!(value: parsed.time, format: "%d/%b/%Y:%H:%M:%S %z")',
    "  .metadata.host = .project",
    "}",
  ],
  realtime: [
    ".metadata.project = del(.project)",
    ".metadata.external_id = .metadata.project",
    "parsed, err = parse_regex(.event_message, r'^(?P<time>\\d+:\\d+:\\d+\\.\\d+) \\[(?P<level>\\w+)\\] (?P<msg>.*)$')",
    "if err == null {",
    "  .event_message = parsed.msg",
    "  .metadata.level = parsed.level",
    "}",
  ],
  storage: [
    ".metadata.project = del(.project)",
    ".metadata.tenantId = .metadata.project",
    "parsed, err = parse_json(.event_message)",
    "if err == null {",
    "  .event_message = parsed.msg",
    "  .metadata.level = parsed.level",
    "  .metadata.timestamp = parsed.time",
    "  .metadata.context[0].host = parsed.hostname",
    "  .metadata.context[0].pid = parsed.pid",
    "}",
  ],
  functions: [".metadata.project_ref = del(.project)"],
  database: [
    '.metadata.host = "db-default"',
    ".metadata.parsed.timestamp = .timestamp",
    "parsed, err = parse_regex(.event_message, r'.*(?P<level>INFO|NOTICE|WARNING|ERROR|LOG|FATAL|PANIC?):.*', numeric_groups: true)",
    "if err != null || parsed == null || parsed.level == null {",
    '  .metadata.parsed.error_severity = "info"',
    "} else {",
    "  .metadata.parsed.error_severity = parsed.level",
    "}",
    'if .metadata.parsed.error_severity == "info" {',
    '  .metadata.parsed.error_severity = "log"',
    "}",
    ".metadata.parsed.error_severity = upcase!(.metadata.parsed.error_severity)",
  ],
};

/**
 * Ships the stack's labelled service containers to Logflare; Vector interpolates `${VAR}` from its
 * env. JSON is valid YAML, so it loads from the recipe's `.yaml` pipeline path.
 */
const containerPipelineConfig = (stack: { readonly id: string; readonly root: string }) =>
  JSON.stringify(
    {
      sources: {
        stack_containers: {
          type: "docker_logs",
          include_labels: [
            `com.supabase.stack=${stack.id}`,
            `com.supabase.stack-root=${stack.root}`,
          ],
        },
      },
      transforms: {
        project_logs: {
          type: "remap",
          inputs: ["stack_containers"],
          source: [
            '.project = "default"',
            ".event_message = del(.message)",
            '.appname = del(.label."com.supabase.service")',
            "del(.container_created_at)",
            "del(.container_id)",
            "del(.container_name)",
            "del(.source_type)",
            "del(.stream)",
            "del(.label)",
            "del(.image)",
            "del(.host)",
          ].join("\n"),
        },
        router: {
          type: "route",
          inputs: ["project_logs"],
          route: Object.fromEntries(
            Object.keys(logflareSources).map((service) => [service, `.appname == "${service}"`]),
          ),
        },
        ...Object.fromEntries(
          Object.entries(serviceTransforms).map(([service, source]) => [
            `${service}_logs`,
            { type: "remap", inputs: [`router.${service}`], source: source.join("\n") },
          ]),
        ),
      },
      sinks: Object.fromEntries(
        Object.entries(logflareSources).map(([service, source]) => [
          `logflare_${service}`,
          {
            type: "http",
            inputs: [`${service}_logs`],
            encoding: { codec: "json" },
            method: "post",
            request: {
              retry_max_duration_secs: 10,
              headers: { "x-api-key": "${LOGFLARE_PRIVATE_ACCESS_TOKEN:-}" },
            },
            uri: `\${LOGFLARE_URL}/api/logs?source_name=${source}`,
          },
        ]),
      ),
    },
    null,
    2,
  );

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
  defaultPipelineConfig: string,
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
    engineApi: true,
    env: (creation, endpoints, container) =>
      requiredInput("vector", "analyticsUrl", creation.config.analyticsUrl).pipe(
        Effect.map((analyticsUrl) => {
          const http = endpoints.get("http");
          return {
            ...(http === undefined
              ? {}
              : { VECTOR_API_ADDRESS: `${container ? "0.0.0.0" : "127.0.0.1"}:${http.port}` }),
            LOGFLARE_URL: analyticsUrl,
            ...(creation.config.apiKey === undefined
              ? {}
              : { LOGFLARE_PRIVATE_ACCESS_TOKEN: creation.config.apiKey }),
          };
        }),
      ),
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
        yield* writeAtomically(fs, path, apiConfigPath, apiConfig);
        if (callerPath === undefined)
          yield* writeAtomically(fs, path, defaultPipelinePath, defaultPipelineConfig);
      }),
    // A caller configPath may live anywhere under the instance root, so only recipe files and empty directories go.
    removeData: () =>
      Effect.gen(function* () {
        yield* ownedInstance("destroy");
        yield* fs.remove(apiConfigPath, { force: true });
        yield* fs.remove(defaultPipelinePath, { force: true });
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
  (creation: Creation, options: CatalogOptions, deps: ProcessDependencies) =>
    makeProcessRecipe(
      creation,
      options,
      deps,
      makeSpec(
        options.instanceId,
        deps.path.join(options.root, options.instanceId),
        options.runtime === "native"
          ? nativePipelineConfig
          : containerPipelineConfig({ id: options.stackId, root: deps.path.resolve(options.root) }),
        deps.fs,
        deps.path,
      ),
    ),
);
