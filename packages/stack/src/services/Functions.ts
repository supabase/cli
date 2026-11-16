import { Clock, Effect, FileSystem, Option, Path, Predicate, Ref, Schema, Semaphore } from "effect";
import { Digest } from "effect/crypto";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import type { PlatformError } from "effect/PlatformError";
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
  type ServiceEndpoint,
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
  /** The host's HTTPS API origin while the API serves TLS, which the banner prefers. */
  hostApiUrl: Schema.optionalKey(Schema.String),
  jwtSecret: Schema.optionalKey(Schema.String),
  jwks: Schema.optionalKey(Schema.String),
  anonKey: Schema.optionalKey(Schema.String),
  serviceRoleKey: Schema.optionalKey(Schema.String),
  publishableKey: Schema.optionalKey(Schema.String),
  secretKey: Schema.optionalKey(Schema.String),
  policy: Schema.optionalKey(Schema.String),
  verifyJwt: Schema.optionalKey(Schema.Boolean),
  inspector: Schema.optionalKey(Schema.Boolean),
  debug: Schema.optionalKey(Schema.Boolean),
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

/** Directories the check skips, so edits there need a restart: dot directories, installed
    packages and vendored modules. */
const skipped = (name: string) =>
  name.startsWith(".") || name === "node_modules" || name === "vendor";

/** Editor and system scratch files, as legacy `functions serve` ignores them. */
const scratch = /^(?:\.DS_Store|\.#.*|\..*\.sw[px]|___.*|.*~|.*\.tmp)$/u;

/* Past this many files and directories a check costs about what the cold boot it saves does, so
   such a functions directory keeps a worker per request. */
const scanBudget = 3_000;

/* Within this long of a file's last write, another same-size write can keep its time on coarse
   or skewed clocks, so files that recent are never trusted to stay current. */
const settleMillis = 1_000;

/**
 * Lists the real path, size, modification time and inode of every source file under `root` and
 * of each `configured` file outside it (resolved per function against the real `root`, as the
 * bootstrap resolves them), where each symlink points, and the newest modification time seen.
 * Only an unreadable `root` fails; anything else under it that cannot be read makes the stamp
 * `trusted: false`. Stops early, as `complete: false`, past `scanBudget` entries.
 */
const sourceStamp = Effect.fn("Functions.sourceStamp")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  configured: ReadonlyArray<{ readonly slug: string; readonly file: string }>,
) {
  const visited = new Set<string>();
  const lines: Array<string> = [];
  let newest = 0;
  let seen = 0;
  let trusted = true;
  /* One limit on file system calls for the whole walk, however deep it goes. */
  const io = yield* Semaphore.make(16);
  const untrusted = Effect.sync(() => {
    trusted = false;
  });
  /* Only a path that is genuinely gone or broken (a dangling or looping link) is part of the stamp;
     any other failure is not trusted. */
  const list = (line: string) =>
    Effect.sync(() => {
      lines.push(line);
    });
  const listMissing =
    (line: string) =>
    (error: PlatformError): Effect.Effect<void> =>
      Predicate.isTagged(error.reason, "NotFound") ||
      Predicate.isTagged(error.reason, "BadResource")
        ? list(line)
        : untrusted;
  const describe = (file: string, onMissing: (error: PlatformError) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const info = yield* io.withPermits(1)(fs.stat(file));
      if (info.type === "Directory") return yield* walk(file);
      const mtime = Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
      newest = Math.max(newest, mtime);
      lines.push(`${file}:${info.size}:${mtime}:${Option.getOrElse(info.ino, () => 0n)}`);
    }).pipe(Effect.catch(onMissing));
  const walk = (directory: string, nested = true): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const real = yield* io.withPermits(1)(fs.realPath(directory));
      /* A symlinked directory is skipped by where it leads, not only by its own name. */
      if (visited.has(real) || (nested && skipped(path.basename(real)))) return;
      visited.add(real);
      const entries = yield* io.withPermits(1)(fs.readDirectoryEntries(real));
      yield* Effect.forEach(
        entries,
        (entry) => {
          if (++seen > scanBudget) return Effect.void;
          const file = path.join(real, entry.name);
          if (entry.type === "Directory")
            return skipped(entry.name) ? Effect.void : describe(file, listMissing(`${file} gone`));
          if (scratch.test(entry.name)) return Effect.void;
          if (entry.type !== "SymbolicLink") return describe(file, listMissing(`${file} gone`));
          /* A link is part of the stamp, so pointing it elsewhere reloads too. */
          return io
            .withPermits(1)(fs.realPath(file))
            .pipe(
              Effect.matchEffect({
                onFailure: listMissing(`${file} -> missing`),
                onSuccess: (target) =>
                  list(`${file} -> ${target}`).pipe(
                    Effect.andThen(describe(file, listMissing(`${file} gone`))),
                  ),
              }),
            );
        },
        { concurrency: "unbounded", discard: true },
      );
    });
  const realRoot = yield* io.withPermits(1)(fs.realPath(root));
  yield* walk(realRoot, false);
  const outside = new Set(
    configured
      .map(({ slug, file }) => path.resolve(realRoot, slug, file))
      .filter((file) => {
        const relative = path.relative(realRoot, file);
        return relative.startsWith("..") || path.isAbsolute(relative);
      }),
  );
  yield* Effect.forEach(outside, (file) => describe(file, listMissing(`${file} missing`)), {
    discard: true,
  });
  /* Sorted, so the order a parallel walk happens to reach shared directories in never matters. */
  return { stamp: lines.sort().join("\n"), newest, trusted, complete: seen <= scanBudget };
});

/** Fixed container mount point for `bootstrap.root`; `args` picks the generation underneath it. */
const containerBootstrapRoot = "/__supabase_bootstrap";

export const makeSpec = (
  bootstrap: FunctionsBootstrapOwner,
  path: Path.Path,
  fs: FileSystem.FileSystem,
  /** Authorises the host's reload announcements; without it the main never reuses a worker. */
  reloadToken?: string,
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
      /* A process env cannot carry these names or values; the JSON runtime config carries them
         once in $default, which the bootstrap merges under each function's own env. */
      const portable = ([name, value]: readonly [string, string]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !/[\0\r\n]/u.test(value);
      const entries = Object.entries(creation.config.env ?? {});
      const configEnv = Object.fromEntries(entries.filter((entry) => !portable(entry)));
      const hasConfigEnv = Object.keys(configEnv).length > 0;
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
      const apiUrl =
        creation.config.apiUrl === undefined ? null : URL.parse(creation.config.apiUrl);
      /* URL.port is empty for the scheme's default port. */
      const hostPort =
        apiUrl === null ? undefined : apiUrl.port || (apiUrl.protocol === "https:" ? "443" : "80");
      return {
        // The image has no passwd entry: Docker then defaults HOME to /, Podman leaves it unset,
        // and the runtime needs it to place its Deno cache.
        ...(container ? { HOME: "/" } : {}),
        ...Object.fromEntries(entries.filter(portable)),
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
        ...(creation.config.verifyJwt === undefined &&
        creation.config.functions === undefined &&
        !hasConfigEnv
          ? {}
          : {
              SUPABASE_INTERNAL_FUNCTIONS_CONFIG: yield* Schema.encodeEffect(
                FunctionsRuntimeConfigJson,
              )({
                $default: {
                  verifyJWT: creation.config.verifyJwt ?? true,
                  ...(hasConfigEnv ? { env: configEnv } : {}),
                },
                ...functions,
              }).pipe(
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
        ...(hostPort === undefined ? {} : { SUPABASE_INTERNAL_HOST_PORT: hostPort }),
        ...(creation.config.hostApiUrl === undefined
          ? {}
          : { SUPABASE_INTERNAL_HOST_URL: creation.config.hostApiUrl }),
        ...(creation.config.debug === true ? { SUPABASE_INTERNAL_DEBUG: "true" } : {}),
        ...(creation.config.databaseUrl === undefined
          ? {}
          : { SUPABASE_DB_URL: creation.config.databaseUrl }),
        ...(creation.config.policy === undefined
          ? {}
          : { EDGE_RUNTIME_POLICY: creation.config.policy }),
        ...(reloadToken === undefined ? {} : { SUPABASE_INTERNAL_RELOAD_TOKEN: reloadToken }),
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
      const root = context.container
        ? `${containerBootstrapRoot}/${path.basename(path.dirname(published))}`
        : path.dirname(published);
      const http = endpoints.get("http");
      const inspector = endpoints.get("inspector");
      return [
        "start",
        `--main-service=${root}`,
        ...(http === undefined
          ? []
          : [`--port=${http.port}`, `--ip=${context.container ? "0.0.0.0" : "127.0.0.1"}`]),
        ...(creation.config.policy === undefined ? [] : [`--policy=${creation.config.policy}`]),
        ...(creation.config.inspector === true && inspector !== undefined
          ? [`--inspect=${context.container ? "0.0.0.0" : "127.0.0.1"}:${inspector.port}`]
          : []),
        ...(creation.config.debug === true ? ["--verbose"] : []),
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
  // No removeData: the bootstrap directory lives under instanceRoot, which ProcessRecipe's
  // destroyOwnedRoot already removes as a single recursive delete starting from a root it has
  // just confirmed is real; a selective removeData reaching into a nested path on its own could
  // instead follow a symlink an attacker (or a race) planted there, deleting outside it.
  callerPaths: (creation) =>
    creation.config.filesRoot === undefined
      ? [creation.config.functionsRoot]
      : [creation.config.functionsRoot, creation.config.filesRoot],
});

export const makeRecipe = Effect.fn("Functions.makeRecipe")(
  (
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
        Effect.provideService(Digest.Digest, deps.digest),
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
      const reloadToken = yield* deps.crypto.uuidV4();
      const recipe = yield* makeProcessRecipe(
        options,
        deps,
        makeSpec(bootstrap, deps.path, deps.fs, reloadToken),
      );
      const announce = (endpoint: ServiceEndpoint, method: "POST" | "DELETE") =>
        deps.client
          .execute(
            HttpClientRequest.make(method)(
              `http://127.0.0.1:${endpoint.port}/_internal/reload`,
            ).pipe(HttpClientRequest.setHeader("x-supabase-reload", reloadToken)),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.text),
            /* The main answers at once; a stalled one fails the request rather than serving old code. */
            Effect.timeout("1 second"),
            Effect.retry({ times: 2 }),
            Effect.mapError(
              (cause) =>
                new CatalogError({
                  operation: "endpoint",
                  message: "Functions did not take the source reload",
                  service: "functions",
                  cause,
                }),
            ),
          );
      /* What the running main was last told: undefined without the stack's own bootstrap, under
         `oneshot` or past the scan budget; `stamp` is the sources it reuses workers for. */
      const sources = yield* Ref.make<
        | {
            readonly root: string;
            readonly configured: ReadonlyArray<{ readonly slug: string; readonly file: string }>;
            readonly reusing: boolean;
            readonly stamp?: string;
          }
        | undefined
      >(undefined);
      const scanning = yield* Semaphore.make(1);
      const scans = yield* Ref.make({ started: 0, finished: 0 });
      const check = Effect.fn("Functions.checkSources")(function* (endpoint: ServiceEndpoint) {
        const current = yield* Ref.get(sources);
        if (current === undefined) return;
        const startedAt = yield* Clock.currentTimeMillis;
        const scanned = yield* sourceStamp(
          deps.fs,
          deps.path,
          current.root,
          current.configured,
        ).pipe(Effect.option);
        if (Option.isSome(scanned) && !scanned.value.complete) {
          if (current.reusing) yield* announce(endpoint, "DELETE");
          yield* Ref.set(sources, undefined);
          return yield* Effect.logWarning(
            `Functions boots a worker per request until restart: ${current.root} holds more than ${scanBudget} entries`,
          );
        }
        const readable = Option.isSome(scanned) && scanned.value.trusted;
        if (!readable || scanned.value.newest >= startedAt - settleMillis) {
          if (current.reusing) {
            /* Marked first, so an interrupted switch-off is announced again, not taken as done. */
            yield* Ref.set(sources, { ...current, stamp: undefined });
            yield* announce(endpoint, "DELETE");
            if (!readable)
              yield* Effect.logWarning(
                `Functions boots a worker per request while ${current.root} cannot be fully read`,
              );
          }
          return yield* Ref.set(sources, { ...current, reusing: false, stamp: undefined });
        }
        if (current.reusing && scanned.value.stamp === current.stamp) return;
        /* Marked first, so a reload that lands before an interruption is still undone by a
           later failed check. */
        yield* Ref.set(sources, { ...current, reusing: true, stamp: undefined });
        yield* announce(endpoint, "POST");
        yield* Ref.set(sources, { ...current, reusing: true, stamp: scanned.value.stamp });
      });
      /* Every request is sent only after a check that began after it arrived, so it never reaches
         a worker older than an edit made before it. Anything unreadable or written within the
         last second gets a fresh worker instead, until it settles. */
      const syncSources = (endpoint: ServiceEndpoint) =>
        Effect.gen(function* () {
          const arrived = (yield* Ref.get(scans)).started;
          yield* scanning.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* Ref.get(scans)).finished > arrived) return;
              const scan = (yield* Ref.updateAndGet(scans, (s) => ({
                ...s,
                started: s.started + 1,
              }))).started;
              yield* check(endpoint);
              yield* Ref.update(scans, (s) => ({ ...s, finished: scan }));
            }),
          );
        });
      return {
        ...recipe,
        beforeTraffic: (name, endpoint) => (name === "http" ? syncSources(endpoint) : Effect.void),
        definition: {
          ...recipe.definition,
          launch: (context) => {
            const { bootstrap, functionsRoot, functions, policy } = context.config.config;
            /* Configured entrypoints and import maps outside the functions directory are checked
               file by file, as legacy `functions serve` watches them. */
            const configured = Object.entries(functions ?? {}).flatMap(([slug, settings]) =>
              settings.enabled === false
                ? []
                : [settings.entrypoint, settings.import_map].flatMap((file) =>
                    file === undefined || file === "" ? [] : [{ slug, file }],
                  ),
            );
            /* Only the stack's own bootstrap takes reload announcements, and Edge Runtime boots a
               worker per request under `oneshot` whatever the main asks. A new main is reset as if
               it might reuse workers, so the first check announces either way. */
            return recipe.definition
              .launch(context)
              .pipe(
                Effect.tap(() =>
                  scanning.withPermits(1)(
                    Ref.set(
                      sources,
                      policy === "oneshot" || bootstrap !== undefined
                        ? undefined
                        : { root: functionsRoot, configured, reusing: true },
                    ),
                  ),
                ),
              );
          },
        },
      };
    }),
);
