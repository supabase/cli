import { Crypto, Effect, FileSystem, Path, Schema } from "effect";
import {
  makeFunctionsBootstrapOwner,
  type FunctionsBootstrapOwner,
} from "../functions/FunctionsBootstrap.ts";
import { defaultFunctionsBootstrap } from "../functions/generated/serve-main-bundle.ts";
import { StackIdSchema } from "../identity/StackId.ts";
import { ServiceError } from "../Service.ts";
import { serviceJwt } from "./ServiceConfig.ts";
import {
  CatalogError,
  EndpointIntent,
  serviceCreation,
  type CatalogOptions,
  type ProcessRecipeResult,
} from "./Recipe.ts";
import {
  makeProcessRecipe,
  type ProcessDependencies,
  type ProcessRecipeSpec,
} from "./ProcessRecipe.ts";

const FunctionSettings = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  verifyJWT: Schema.optionalKey(Schema.Boolean),
  entrypoint: Schema.optionalKey(Schema.String),
  import_map: Schema.optionalKey(Schema.String),
  static_files: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export const Config = Schema.Struct({
  functionsRoot: Schema.String,
  filesRoot: Schema.optionalKey(Schema.String),
  functions: Schema.optionalKey(Schema.Record(Schema.String, FunctionSettings)),
  bootstrap: Schema.optionalKey(Schema.String),
  databaseUrl: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  apiUrl: Schema.optionalKey(Schema.String),
  jwtSecret: Schema.optionalKey(Schema.String),
  jwks: Schema.optionalKey(Schema.String),
  anonKey: Schema.optionalKey(Schema.String),
  serviceRoleKey: Schema.optionalKey(Schema.String),
  publishableKey: Schema.optionalKey(Schema.String),
  secretKey: Schema.optionalKey(Schema.String),
  policy: Schema.optionalKey(Schema.String),
  verifyJwt: Schema.optionalKey(Schema.Boolean),
  inspector: Schema.optionalKey(Schema.Boolean),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({
  http: Schema.optionalKey(EndpointIntent),
  inspector: Schema.optionalKey(EndpointIntent),
});

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("functions", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

const FunctionsRuntimeConfigJson = Schema.fromJsonString(
  Schema.Record(Schema.String, FunctionSettings),
);

/** Fixed container mount point for `bootstrap.root`; `args` picks the generation underneath it. */
const containerBootstrapRoot = "/__supabase_bootstrap";

export const makeSpec = (
  bootstrap: FunctionsBootstrapOwner,
  path: Path.Path,
  fs: FileSystem.FileSystem,
): ProcessRecipeSpec<Creation> => ({
  service: "functions",
  executable: "bin/edge-runtime",
  ports: { http: 9000, inspector: 9229 },
  healthPath: "/_internal/health",
  enabledPort: (creation, name) => name !== "inspector" || creation.config.inspector === true,
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const http = endpoints.get("http");
      const filesRoot = creation.config.filesRoot;
      const canonicalFilesRoot =
        filesRoot === undefined || container
          ? filesRoot
          : yield* fs.realPath(filesRoot).pipe(
              Effect.mapError(
                (cause) =>
                  new ServiceError({
                    operation: "launch",
                    message: "Unable to resolve Functions project directory",
                    cause,
                  }),
              ),
            );
      const runtimePath = (value: string) => {
        if (!path.isAbsolute(value) || filesRoot === undefined || canonicalFilesRoot === undefined)
          return value;
        const relative = path.relative(filesRoot, value);
        // Container paths are POSIX regardless of the host path flavor.
        return container
          ? ["/__supabase_project", ...relative.split(path.sep).filter((part) => part !== "")].join(
              "/",
            )
          : path.join(canonicalFilesRoot, relative);
      };
      const root =
        container && filesRoot === undefined
          ? "/__supabase_functions"
          : runtimePath(creation.config.functionsRoot);
      const functions = Object.fromEntries(
        Object.entries(creation.config.functions ?? {}).map(([name, settings]) => [
          name,
          {
            ...settings,
            ...(settings.entrypoint === undefined
              ? {}
              : { entrypoint: runtimePath(settings.entrypoint) }),
            ...(settings.import_map === undefined
              ? {}
              : { import_map: runtimePath(settings.import_map) }),
            ...(settings.static_files === undefined
              ? {}
              : { static_files: settings.static_files.map(runtimePath) }),
            ...(creation.config.verifyJwt === false ? { verifyJWT: false } : {}),
          },
        ]),
      );
      const jwt = creation.config.jwtSecret;
      const anonKey =
        creation.config.anonKey ?? (jwt === undefined ? undefined : yield* serviceJwt("anon", jwt));
      const serviceRoleKey =
        creation.config.serviceRoleKey ??
        (jwt === undefined ? undefined : yield* serviceJwt("service_role", jwt));
      return {
        ...creation.config.env,
        ...(http === undefined ? {} : { EDGE_RUNTIME_PORT: String(http.port) }),
        SUPABASE_INTERNAL_FUNCTIONS_ROOT: root,
        ...(filesRoot === undefined
          ? {}
          : { SUPABASE_INTERNAL_FUNCTIONS_FILES_ROOT: runtimePath(filesRoot) }),
        ...(jwt === undefined ? {} : { SUPABASE_INTERNAL_JWT_SECRET: jwt }),
        ...(creation.config.jwks === undefined ? {} : { SUPABASE_JWKS: creation.config.jwks }),
        ...(anonKey === undefined ? {} : { SUPABASE_ANON_KEY: anonKey }),
        ...(serviceRoleKey === undefined ? {} : { SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey }),
        ...(creation.config.publishableKey === undefined
          ? {}
          : { SUPABASE_INTERNAL_PUBLISHABLE_KEY: creation.config.publishableKey }),
        ...(creation.config.secretKey === undefined
          ? {}
          : { SUPABASE_INTERNAL_SECRET_KEY: creation.config.secretKey }),
        ...(creation.config.verifyJwt === undefined && creation.config.functions === undefined
          ? {}
          : {
              SUPABASE_INTERNAL_FUNCTIONS_CONFIG: yield* Schema.encodeEffect(
                FunctionsRuntimeConfigJson,
              )({ $default: { verifyJWT: creation.config.verifyJwt ?? true }, ...functions }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServiceError({
                      operation: "launch",
                      message: "Unable to encode Functions runtime configuration",
                      cause,
                    }),
                ),
              ),
            }),
        ...(creation.config.apiUrl === undefined ? {} : { SUPABASE_URL: creation.config.apiUrl }),
        ...(creation.config.databaseUrl === undefined
          ? {}
          : { SUPABASE_DB_URL: creation.config.databaseUrl }),
        ...(creation.config.policy === undefined
          ? {}
          : { EDGE_RUNTIME_POLICY: creation.config.policy }),
      };
    }),
  args: (creation, endpoints, context) =>
    Effect.gen(function* () {
      const published = yield* bootstrap
        .write({ content: creation.config.bootstrap ?? defaultFunctionsBootstrap })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ServiceError({
                operation: "launch",
                message: "Unable to publish Functions bootstrap",
                cause,
              }),
          ),
        );
      // Safe here: a previous generation's container is confirmed stopped by the time `args` runs
      // for a fresh launch; `prepare` can still run while that container is live.
      yield* bootstrap.pruneOthers(path.dirname(published)).pipe(
        Effect.mapError(
          (cause) =>
            new ServiceError({
              operation: "launch",
              message: "Unable to prune Functions bootstrap",
              cause,
            }),
        ),
      );
      const root = context.container
        ? `${containerBootstrapRoot}/${path.basename(path.dirname(published))}`
        : path.dirname(published);
      const http = endpoints.get("http");
      const inspector = endpoints.get("inspector");
      return [
        "start",
        `--main-service=${root}`,
        ...(http === undefined ? [] : [`--port=${http.port}`]),
        ...(creation.config.policy === undefined ? [] : [`--policy=${creation.config.policy}`]),
        ...(creation.config.inspector === true && inspector !== undefined
          ? [`--inspect=${context.container ? "0.0.0.0" : "127.0.0.1"}:${inspector.port}`]
          : []),
      ];
    }),
  mounts: (creation) =>
    Effect.succeed([
      {
        source: creation.config.filesRoot ?? creation.config.functionsRoot,
        target:
          creation.config.filesRoot === undefined ? "/__supabase_functions" : "/__supabase_project",
        readOnly: true,
      },
      { source: bootstrap.root, target: containerBootstrapRoot, readOnly: true },
    ]),
  startupCommands: [],
  // Prefetches the bootstrap so a later start need not pay for it; `args` publishes idempotently.
  prepare: (creation) =>
    bootstrap.write({ content: creation.config.bootstrap ?? defaultFunctionsBootstrap }).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new ServiceError({
            operation: "prepare",
            message: "Unable to prepare Functions bootstrap",
            cause,
          }),
      ),
    ),
  removeData: () =>
    bootstrap.cleanupAll.pipe(
      Effect.mapError(
        (cause) =>
          new ServiceError({
            operation: "destroy",
            message: "Unable to remove Functions bootstrap",
            cause,
          }),
      ),
    ),
});

export const makeRecipe = Effect.fn("Functions.makeRecipe")(
  (
    creation: Creation,
    options: CatalogOptions,
    deps: ProcessDependencies,
  ): Effect.Effect<ProcessRecipeResult<Creation>, CatalogError> =>
    Effect.gen(function* () {
      const stackId = yield* Schema.decodeEffect(StackIdSchema)(options.stackId).pipe(
        Effect.mapError(
          (cause) =>
            new CatalogError({
              operation: "functions",
              message: "Invalid stack identity",
              service: "functions",
              cause,
            }),
        ),
      );
      const bootstrap = yield* makeFunctionsBootstrapOwner({
        root: options.root,
        stackId,
        instanceId: options.instanceId,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, deps.fs),
        Effect.provideService(Path.Path, deps.path),
        Effect.provideService(Crypto.Crypto, deps.crypto),
        Effect.mapError(
          (cause) =>
            new CatalogError({
              operation: "functions",
              message: "Unable to create Functions bootstrap owner",
              service: "functions",
              cause,
            }),
        ),
      );
      return yield* makeProcessRecipe(
        creation,
        options,
        deps,
        makeSpec(bootstrap, deps.path, deps.fs),
      );
    }),
);
