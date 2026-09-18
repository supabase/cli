import { bitbucketCloneDir } from "../../command-internal/bitbucket-pipeline.ts";
import {
  CliConfigSchema,
  findCliProjectPaths,
  inferFunctionsManifest,
  type CliConfig,
  type CliProjectEnvironment,
  type ResolvedCliConfigValue,
  type ResolvedFunctionConfig as ManifestFunctionConfig,
} from "@supabase/config/effect";
import {
  loadCliConfig,
  resolveCliConfigSubtree,
  resolveCliConfigValue,
} from "@supabase/config/internal";
import { edgeRuntimeNofileUlimit } from "../stack-constants.ts";
import { styleText } from "node:util";
import {
  Config,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { parseDotEnv } from "../../command-internal/dotenv.ts";
import { Output } from "../output/output.service.ts";
import type { EffectServiceConfig, EffectServiceInstance } from "@supabase/stack/effect";
import {
  FileWatcher,
  FileWatcherError,
  type FileWatchEvent,
} from "../runtime/file-watcher.service.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import {
  buildDockerBinds,
  discoverFunctionSlugs,
  type DockerBind,
  formatDockerBind,
  pruneRedundantDockerBinds,
  dockerWorkdirLabel,
  rawFunctionConfigRecord,
  resolveFunctionConfigs,
  type ResolvedDeployFunctionConfig,
} from "./deploy.ts";
import {
  containerArchiveBytes,
  dockerProjectLabels,
  edgeRuntimeCacheVolume,
  ensureDockerNamedVolume,
  ensureDockerNetwork,
  localDockerId,
  normalizeProjectId,
  runChildProcess,
  toDockerPath,
} from "./functions-docker.ts";
import { loadFunctionsCliConfig, type FunctionsGoConfigCompat } from "./functions-config.ts";
import { StackApi } from "../../command-internal/stack-api.ts";
import { loadStackConfig } from "../../command-internal/stack-config.ts";
import { FunctionsServeError } from "./serve.errors.ts";
const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const defaultCliConfig = decodeCliConfig({});

const dockerRuntimeServerPort = 8081;
const dockerRuntimeInspectorPort = 8083;
// Unix timestamp (~2032-11-30) used as the `exp` claim of the local-dev
// default JWTs (anon/service_role tokens).
const functionsDirName = "supabase/functions";
const fallbackEnvFilePath = "supabase/functions/.env";
const ignoredDirNames = new Set([
  ".git",
  "node_modules",
  ".vscode",
  ".idea",
  ".DS_Store",
  "vendor",
]);
// On Windows, `CTRL_C_EVENT` reaches every console-attached process, so the CLI's own shutdown
// signal and a child spawn/stream failure can land microseconds apart — this is their tie-break.
// Exit codes a supervisor uses to tear a container down (`supabase stop`, CI cancellation),
// not a self-raised crash signal; 137 is excluded because it gets its own OOM-kill retry.
// Consecutive re-attaches to `docker logs -f` without forwarding a new line before giving up on
// the stream and failing loudly instead of flooding replayed history forever.
const defaultSupabaseEnv = "development";
const serveMainDir = "/root";
const shellVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
let cachedFunctionsServeMainTemplate: string | undefined;

const functionsServeError = (message: string, cause?: unknown) =>
  new FunctionsServeError({ message, cause });

const watchIgnoreGlobs = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.vscode/**",
  "**/.idea/**",
  "**/.DS_Store",
  "**/vendor/**",
  "**/*~",
  "**/.*.swp",
  "**/.*.swx",
  "**/___*",
  "**/*.tmp",
  "**/.#*",
] as const;

export const FUNCTIONS_SERVE_INSPECT_MODES = ["run", "brk", "wait"] as const;

export type FunctionsServeInspectMode = (typeof FUNCTIONS_SERVE_INSPECT_MODES)[number];

export interface FunctionsServeFlags {
  readonly noVerifyJwt: Option.Option<boolean>;
  readonly envFile: Option.Option<string>;
  readonly importMap: Option.Option<string>;
  readonly inspect: boolean;
  readonly inspectMode: Option.Option<FunctionsServeInspectMode>;
  readonly inspectMain: boolean;
  readonly all: boolean;
}

export interface FunctionsServeDependencies {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly flagCwd: string;
  readonly platform: NodeJS.Platform;
  readonly debug: boolean;
  readonly networkId: Option.Option<string>;
  readonly projectIdOverride: Option.Option<string>;
  readonly goViperCompat: boolean;
  /**
   * `undefined` for library callers; the CLI injects this so this file
   * never imports the command tree directly — see {@link FunctionsGoConfigCompat}.
   * Distinct from `goViperCompat` above, which only gates `env(...)` interpolation.
   */
  readonly goConfigCompat: FunctionsGoConfigCompat | undefined;
  /** Overrides the shutdown-grace and log-retry timers; production leaves this unset. */
  readonly timers?: FunctionsServeTimers;
}

/** @see {@link FunctionsServeDependencies.timers} */
interface FunctionsServeTimers {
  readonly shutdownSignalGracePeriod?: Duration.Duration;
  readonly dockerLogRetryDelay?: Duration.Duration;
}

export interface PlainServeEdgeRuntimeConfig {
  readonly policy: CliConfig["edge_runtime"]["policy"];
  readonly inspector_port: number;
  readonly deno_version?: number;
  readonly secrets: Readonly<Record<string, string>>;
}

interface ServeResolvedConfig {
  readonly projectId: string;
  readonly apiPort: number;
  readonly edgeRuntime: PlainServeEdgeRuntimeConfig;
  readonly configDeclaredFunctions: Readonly<Record<string, ManifestFunctionConfig>>;
  readonly configFunctions: Readonly<Record<string, ManifestFunctionConfig>>;
  readonly rawConfigFunctions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly configPath?: string;
  /** Merged env with ambient values winning; `undefined` for library callers. */
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
}

interface ServeFunctionContainerConfig {
  readonly verifyJWT: boolean;
  readonly entrypointPath: string;
  readonly importMapPath?: string;
  readonly staticFiles?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

interface WatchSpec {
  readonly root: string;
  readonly recursive: boolean;
  readonly matchPaths?: ReadonlySet<string>;
}

export interface StartedRuntime {
  readonly containerId: string;
  readonly cleanup: Effect.Effect<void>;
  readonly watchSpecs: ReadonlyArray<WatchSpec>;
}

/**
 * Every already-resolved secret/key {@link startEdgeRuntimeContainer} needs.
 * Exported so a caller outside this module (`start`'s own edge-runtime
 * bring-up) can build this from values it already resolved.
 */
export interface ServeAuthArtifacts {
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly jwtSecret: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly jwks: string;
}

/**
 * Everything {@link startEdgeRuntimeContainer} needs from `config.toml`
 * beyond auth (see {@link ServeAuthArtifacts}) — a narrowed view of
 * {@link ServeResolvedConfig}. `start`'s own bring-up builds this directly
 * from its own already-loaded `CliConfig` rather than going through
 * {@link resolveServeConfig}'s independent config-loading pipeline.
 */
export interface ServeEdgeRuntimeContainerConfig {
  readonly projectId: string;
  readonly apiPort: number;
  readonly edgeRuntimePolicy: string;
  readonly edgeRuntimeInspectorPort: number;
  readonly edgeRuntimeSecrets: Readonly<Record<string, string>>;
  readonly configDeclaredFunctions: Readonly<Record<string, ManifestFunctionConfig>>;
  readonly configFunctions: Readonly<Record<string, ManifestFunctionConfig>>;
  readonly rawConfigFunctions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Input to {@link startEdgeRuntimeContainer} — the reusable "bring up one
 * Edge Runtime container" core extracted from `serveFunctions`'s interactive
 * loop, kept independent of both `functions serve`'s own config-loading and
 * its file-watch/log-stream loop, so `start`'s bring-up can call it directly
 * with values already resolved through its own pipeline.
 */
export interface StartEdgeRuntimeContainerInput {
  readonly onContainerCreated?: () => void;
  readonly config: ServeEdgeRuntimeContainerConfig;
  readonly authArtifacts: ServeAuthArtifacts;
  /**
   * `SUPABASE_DB_URL`. The caller supplies the database endpoint.
   * Every caller must supply its own value; this module does not choose one.
   */
  readonly dbUrl: string;
  /** Already-resolved edge-runtime image reference (registry-mapped, tag/deno-version already applied). */
  readonly image: string;
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly flagCwd: string;
  readonly platform: NodeJS.Platform;
  readonly debug: boolean;
  readonly networkId: string;
  readonly envFile: Option.Option<string>;
  /** Standalone `functions serve` discovers `supabase/functions/<slug>/.env`; `start` does not. */
  readonly discoverFunctionEnvFiles: boolean;
  readonly importMap: Option.Option<string>;
  readonly noVerifyJwt: Option.Option<boolean>;
  readonly inspectMode: FunctionsServeInspectMode | undefined;
  readonly inspectMain: boolean;
  /** Project dotenv values used for Bitbucket's Docker restrictions. */
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

declare const SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE: string | undefined;

export const serveFileWatcherLayer = Layer.effect(
  FileWatcher,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return FileWatcher.of({
      watch: (root, options) =>
        fs.watch(root, { recursive: options?.recursive ?? true }).pipe(
          Stream.mapEffect((event) => {
            const pathname = path.isAbsolute(event.path)
              ? event.path
              : path.resolve(root, event.path);
            return Match.value(event).pipe(
              Match.tag("Update", () =>
                Effect.succeed([{ path: pathname, type: "update" } satisfies FileWatchEvent]),
              ),
              Match.tag("Create", "Remove", () =>
                fs.exists(pathname).pipe(
                  Effect.map((exists) => [
                    {
                      path: pathname,
                      type: exists ? "create" : "delete",
                    } satisfies FileWatchEvent,
                  ]),
                ),
              ),
              Match.exhaustive,
            );
          }),
          Stream.mapError((cause) => new FileWatcherError({ path: root, cause })),
        ),
    });
  }),
);

/**
 * `serve.main.ts` runs verbatim as a Deno entrypoint inside the edge-runtime
 * container (written to `/root/index.ts`), bundled into a single
 * self-contained module so its `jose` and local helper dependencies are
 * inlined and the runtime needs no network access on start.
 *
 * Compiled builds embed the pre-bundled template via the
 * `SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE` define (see `scripts/build.ts`),
 * so the shipped binary never bundles at runtime. Running from source
 * bundles on demand.
 */
const getFunctionsServeMainTemplate = Effect.suspend(() =>
  Effect.gen(function* () {
    if (cachedFunctionsServeMainTemplate !== undefined) {
      return cachedFunctionsServeMainTemplate;
    }
    if (typeof SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE === "string") {
      cachedFunctionsServeMainTemplate = SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE;
      return cachedFunctionsServeMainTemplate;
    }
    // Bundler (and its esbuild dependency) is imported lazily and only here,
    // so it's never loaded by shipped binaries, which always take the define
    // branch above.
    const { bundleServeMainTemplate } = yield* Effect.tryPromise(
      () => import("./serve-main-bundler.ts"),
    );
    const bundled = yield* bundleServeMainTemplate;
    cachedFunctionsServeMainTemplate = bundled;
    return bundled;
  }),
);

function reveal(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Redacted.isRedacted(value)) return undefined;
  const revealed = Redacted.value(value);
  return typeof revealed === "string" ? revealed : undefined;
}

/**
 * Exported so `start`'s own edge-runtime bring-up can reuse this exact
 * `Redacted`-unwrapping/zero-hash-filtering logic against its own,
 * already-loaded `CliConfig` instead of duplicating it.
 */
export function toPlainEdgeRuntimeConfig(
  edgeRuntime: CliConfig["edge_runtime"] | ResolvedCliConfigValue<CliConfig["edge_runtime"]>,
): PlainServeEdgeRuntimeConfig {
  return {
    policy: reveal(edgeRuntime.policy) ?? "",
    inspector_port: edgeRuntime.inspector_port,
    deno_version: edgeRuntime.deno_version,
    // Secret names always reach the container env uppercased regardless of
    // authored casing. Only resolved (non-empty) values are kept — an
    // unresolved `env(VAR)` literal stays a plain string, not `Redacted`, so
    // `Redacted.isRedacted` + non-empty filters it out, the same guard
    // `secrets set` uses.
    secrets: Object.fromEntries(
      Object.entries(edgeRuntime.secrets ?? {}).flatMap(([name, value]) =>
        Redacted.isRedacted(value) && Redacted.value(value).length > 0
          ? [[name.toUpperCase(), Redacted.value(value)] as const]
          : [],
      ),
    ),
  };
}

/** Exported for the same reason as {@link toPlainEdgeRuntimeConfig}. */
export function toPlainFunctionRecord(
  functions: CliConfig["functions"] | ResolvedCliConfigValue<CliConfig["functions"]>,
): Readonly<Record<string, ManifestFunctionConfig>> {
  return Object.fromEntries(
    Object.entries(functions).map(([slug, config]) => [
      slug,
      {
        enabled: config.enabled,
        verify_jwt: config.verify_jwt,
        import_map: reveal(config.import_map) ?? "",
        entrypoint: reveal(config.entrypoint) ?? "",
        static_files: config.static_files.map((value) => reveal(value) ?? ""),
        env: Object.fromEntries(
          Object.entries(config.env).map(([name, value]) => [name, reveal(value) ?? ""]),
        ),
      } satisfies ManifestFunctionConfig,
    ]),
  );
}

const resolveServeConfig = Effect.fnUntraced(function* (
  projectRoot: string,
  projectIdOverride: Option.Option<string>,
  goViperCompat: boolean,
  goConfigCompat: FunctionsGoConfigCompat | undefined,
) {
  const path = yield* Path.Path;
  // Keeps `.env` discovery, config load, and functions-manifest inference
  // from resolving three different roots: the CLI's `search: false` must
  // match `loadFunctionsCliConfig`'s own options exactly (see below).
  const searchAncestors = goConfigCompat === undefined;
  const projectEnv = yield* loadServeCliProjectEnvironment(projectRoot, {
    search: searchAncestors,
  });
  const projectRef = Option.match(projectIdOverride, {
    onNone: () => undefined,
    onSome: (value) => {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : undefined;
    },
  });
  // We resolve the project environment ourselves (layering
  // `.env.<SUPABASE_ENV>`/`.env.local`/`.env` over the ambient env) and pass
  // it in, so `loadCliConfig`'s `env()` interpolation neither re-reads those
  // files nor mutates `process.env`.
  //
  // `search`/`tomlOnly` here must match `loadFunctionsCliConfig`'s own
  // options below exactly, or the two loads can resolve two different files,
  // silently mixing fields from two different projects. Library callers
  // (`goConfigCompat === undefined`) keep the package defaults unchanged.
  const loadedConfig = yield* loadCliConfig(projectRoot, {
    ...(projectRef === undefined ? {} : { projectRef }),
    ...(projectEnv === null ? {} : { cliProjectEnv: projectEnv }),
    goViperCompat,
    search: searchAncestors,
    ...(goConfigCompat === undefined ? {} : { tomlOnly: true }),
  });
  const baseConfig = loadedConfig?.config ?? defaultCliConfig;

  const edgeRuntime =
    projectEnv === null
      ? toPlainEdgeRuntimeConfig(baseConfig.edge_runtime)
      : toPlainEdgeRuntimeConfig(
          yield* resolveCliConfigSubtree(baseConfig.edge_runtime, projectEnv, "edge_runtime", {
            goViperCompat,
          }),
        );
  const apiPort =
    projectEnv === null
      ? baseConfig.api.port
      : (yield* resolveCliConfigSubtree(baseConfig.api, projectEnv, "api", { goViperCompat })).port;
  const configDeclaredFunctions =
    projectEnv === null
      ? toPlainFunctionRecord(baseConfig.functions)
      : toPlainFunctionRecord(
          yield* resolveCliConfigSubtree(baseConfig.functions, projectEnv, "functions", {
            goViperCompat,
          }),
        );
  const configForManifest: CliConfig = {
    ...baseConfig,
    functions: configDeclaredFunctions,
  };
  const configFunctions = yield* inferFunctionsManifest({
    cwd: projectRoot,
    config: configForManifest,
    search: searchAncestors,
  });
  const configProjectId =
    projectEnv === null
      ? (baseConfig.project_id ?? "")
      : (reveal(
          yield* resolveCliConfigValue(baseConfig.project_id ?? "", projectEnv, "project_id", {
            goViperCompat,
          }),
        ) ?? "");
  const rawProjectId = Option.getOrElse(projectIdOverride, () => configProjectId).trim();
  const fallbackProjectId = path.basename(path.resolve(projectRoot));

  // A second, independent config/dotenv load, run before any Docker check so
  // an invalid config fails here too; its `search`/`tomlOnly` must match the
  // `loadedConfig` call above or the two loads can pick different files.
  // Known gap: `projectId` only sees ambient-shell `SUPABASE_PROJECT_ID`, not
  // project dotenv, so a project setting it only in `.env` gets a different
  // Docker network than `deploy`/`download`/`start` — a silently broken `serve`.
  const goContext =
    goConfigCompat === undefined
      ? undefined
      : yield* loadFunctionsCliConfig({
          projectRoot,
          projectRef,
          goConfigCompat,
        });

  return {
    projectId: normalizeProjectId(rawProjectId.length > 0 ? rawProjectId : fallbackProjectId),
    apiPort,
    edgeRuntime:
      goContext === undefined
        ? edgeRuntime
        : { ...edgeRuntime, deno_version: goContext.denoVersion },
    configDeclaredFunctions,
    configFunctions,
    rawConfigFunctions: rawFunctionConfigRecord(loadedConfig?.document),
    configPath: loadedConfig?.path,
    projectEnvValues: goContext?.projectEnvValues,
  } satisfies ServeResolvedConfig;
});

export function resolveFunctionsServeInspectMode(
  flags: FunctionsServeFlags,
): FunctionsServeInspectMode | undefined {
  if (flags.inspect && Option.isSome(flags.inspectMode)) {
    throw new Error(
      "if any flags in the group [inspect inspect-mode] are set none of the others can be; [inspect inspect-mode] were all set",
    );
  }
  if (Option.isSome(flags.inspectMode)) {
    return flags.inspectMode.value;
  }
  return flags.inspect ? "brk" : undefined;
}

export function buildFunctionsServeInspectArgs(
  inspectMode: FunctionsServeInspectMode | undefined,
  inspectMain: boolean,
) {
  if (inspectMode === undefined) {
    if (inspectMain) {
      throw new Error(
        "--inspect-main must be used together with one of these flags: [inspect inspect-mode]",
      );
    }
    return [];
  }

  const flag =
    inspectMode === "brk" ? "inspect-brk" : inspectMode === "wait" ? "inspect-wait" : "inspect";
  return [
    `--${flag}=0.0.0.0:${dockerRuntimeInspectorPort}`,
    ...(inspectMain ? ["--inspect-main"] : []),
  ];
}

const readDotEnvFile = Effect.fnUntraced(function* (pathname: string, optional: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs
    .readFileString(pathname)
    .pipe(
      Effect.catchTag("PlatformError", (cause) =>
        cause.reason._tag === "NotFound" && optional
          ? Effect.map(Effect.void, () => undefined)
          : Effect.fail(
              functionsServeError(
                `failed to load environment file: ${pathname}: ${cause.message}`,
                cause,
              ),
            ),
      ),
    );
  if (contents === undefined) {
    return {};
  }
  return yield* Effect.try({
    try: () => parseDotEnv(contents),
    catch: (cause) => sanitizeDotEnvParseError(pathname, cause),
  });
});

const filterCustomEnv = Effect.fnUntraced(function* (env: Readonly<Record<string, string>>) {
  const output = yield* Output;
  const filtered: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("SUPABASE_")) {
      yield* output.raw(`Env name cannot start with SUPABASE_, skipping: ${name}\n`, "stderr");
      continue;
    }
    filtered.push([name, value]);
  }
  return Object.fromEntries(filtered);
});

const parseCustomEnvFile = Effect.fnUntraced(function* (
  envFileFlag: Option.Option<string>,
  projectRoot: string,
  flagCwd: string,
  configSecrets: Readonly<Record<string, string>>,
) {
  const path = yield* Path.Path;
  const envFilePath = Option.match(envFileFlag, {
    onNone: () => path.join(projectRoot, fallbackEnvFilePath),
    onSome: (pathname) => (path.isAbsolute(pathname) ? pathname : path.resolve(flagCwd, pathname)),
  });
  const parsed = yield* readDotEnvFile(envFilePath, Option.isNone(envFileFlag));
  const filtered = yield* filterCustomEnv({ ...configSecrets, ...parsed });
  return Object.entries(filtered).map(([name, value]) => `${name}=${value}`);
});

const parseFunctionEnvFile = Effect.fnUntraced(function* (pathname: string) {
  return yield* readDotEnvFile(pathname, true).pipe(Effect.flatMap(filterCustomEnv));
});

function toFunctionContainerConfig(
  path: Path.Path,
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  envFile: Readonly<Record<string, string>>,
): ServeFunctionContainerConfig {
  const toContainerPath = (pathname: string) => {
    const resolvedPath = path.resolve(pathname);
    const relativePath = path.relative(workdir, resolvedPath);
    return relativePath.length === 0
      ? path.basename(resolvedPath)
      : relativePath.replaceAll("\\", "/");
  };

  return {
    // Defaults to `true` when `verify_jwt` is unset, unlike `deploy` which
    // omits it.
    verifyJWT: config.verifyJwt ?? true,
    entrypointPath: toContainerPath(config.entrypoint),
    ...(config.importMap.length === 0 ? {} : { importMapPath: toContainerPath(config.importMap) }),
    ...(config.staticFiles.length === 0
      ? {}
      : { staticFiles: config.staticFiles.map((pathname) => toContainerPath(pathname)) }),
    ...(Object.keys(envFile).length === 0 && Object.keys(config.env).length === 0
      ? {}
      : { env: { ...envFile, ...config.env } }),
  };
}

function splitEnvEntry(entry: string) {
  const separatorIndex = entry.indexOf("=");
  return separatorIndex === -1
    ? ([entry, ""] as const)
    : ([entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)] as const);
}

const writeDockerEnvFile = Effect.fnUntraced(function* (
  env: Readonly<Record<string, string>>,
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathApi = yield* Path.Path;
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return undefined;
  }

  // Self-healing: `dir` is a deterministic, reused path (not a fresh mkdtemp
  // each call), so a stale directory from an earlier invocation in the same
  // process (e.g. `functions serve`'s watch-mode restart loop) is removed
  // first — otherwise leftover files from a shrinking env set would survive
  // alongside the fresh write.
  yield* fs.remove(dir, { recursive: true, force: true });
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  const path = pathApi.join(dir, "docker.env");
  // The file holds the JWT secret, anon/service-role keys, and JWKS, so keep it
  // owner-only rather than relying on the process umask.
  yield* fs.writeFileString(
    path,
    entries
      .map(([name, value]) => `${name}=${value.replaceAll("\r", "\\r").replaceAll("\n", "\\n")}`)
      .join("\n"),
    { mode: 0o600 },
  );

  return { path };
});

const writeDockerMultilineEnvScript = Effect.fnUntraced(function* (
  env: ReadonlyArray<readonly [string, string]>,
  containerDir: string,
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathApi = yield* Path.Path;
  // Self-healing — see the matching comment in `writeDockerEnvFile`. Runs
  // unconditionally, before the length check, so a stale directory from an
  // earlier invocation that needed multiline secrets is still reclaimed.
  yield* fs.remove(dir, { recursive: true, force: true });

  if (env.length === 0) {
    return undefined;
  }

  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  const scriptName = "multiline-env.sh";
  const path = pathApi.join(dir, scriptName);
  const envDir = pathApi.join(containerDir, "values");
  const hostEnvDir = pathApi.join(dir, "values");
  // Names are validated by `validateDockerMultilineEnvNames` before this runs.
  const script = env
    .map(([name], index) => {
      const valueFile = `env-${index}`;
      const valuePath = pathApi.join(envDir, valueFile).replaceAll("\\", "/");
      return `${name}="$(cat ${valuePath}; printf x)"
export ${name}="\${${name}%x}"`;
    })
    .join("\n");
  yield* fs.makeDirectory(hostEnvDir, { recursive: true, mode: 0o700 });
  // The value files hold secret env values, so keep them owner-only.
  yield* Effect.forEach(
    env,
    ([, value], index) =>
      fs.writeFileString(pathApi.join(hostEnvDir, `env-${index}`), value, { mode: 0o600 }),
    { concurrency: "unbounded", discard: true },
  );
  yield* fs.writeFileString(path, script, { mode: 0o600 });

  return {
    // `Z`: private SELinux relabel of this CLI-staged dir (supabase/cli#5989);
    // single-consumer bind, no-op without SELinux.
    bind: `${dir}:${containerDir}:ro,Z`,
    scriptPath: pathApi.join(containerDir, scriptName).replaceAll("\\", "/"),
  };
});

function partitionDockerEnvEntries(env: Readonly<Record<string, string>>) {
  const singleLine: Record<string, string> = {};
  const multiline: Array<readonly [string, string]> = [];

  for (const [name, value] of Object.entries(env)) {
    if (value.includes("\n") || value.includes("\r")) {
      multiline.push([name, value]);
      continue;
    }
    singleLine[name] = value;
  }

  return { singleLine, multiline } as const;
}

function validateDockerMultilineEnvNames(env: ReadonlyArray<readonly [string, string]>) {
  for (const [name] of env) {
    if (!shellVariableNamePattern.test(name)) {
      throw new Error(`invalid multiline environment variable name for shell export: ${name}`);
    }
  }
}

function loadDefaultEnvFilenames(env: string) {
  return [`.env.${env}.local`, ...(env === "test" ? [] : [".env.local"]), `.env.${env}`, ".env"];
}

function sanitizeDotEnvParseError(path: string, cause: unknown) {
  if (!(cause instanceof Error)) {
    return functionsServeError(`failed to parse environment file: ${path}`, cause);
  }
  const message = cause.message;
  if (message.startsWith('unexpected character "')) {
    const prefix = 'unexpected character "';
    const start = message.indexOf(prefix);
    if (start !== -1) {
      const charStart = start + prefix.length;
      const charEnd = message.indexOf('"', charStart);
      if (charEnd !== -1) {
        const char = message.slice(charStart, charEnd);
        return functionsServeError(
          `failed to parse environment file: ${path} (unexpected character '${char}' in variable name)`,
          cause,
        );
      }
    }
    return functionsServeError(
      `failed to parse environment file: ${path} (unexpected character in variable name)`,
      cause,
    );
  }
  if (message.startsWith("unterminated quoted value")) {
    return functionsServeError(
      `failed to parse environment file: ${path} (unterminated quoted value)`,
      cause,
    );
  }
  if (message.includes("\n")) {
    return functionsServeError(`failed to parse environment file: ${path} (syntax error)`, cause);
  }
  return functionsServeError(`failed to load ${path}: ${message}`, cause);
}

function ambientProjectEnv() {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

const loadServeCliProjectEnvironment = Effect.fnUntraced(function* (
  projectRoot: string,
  options: { readonly search: boolean },
) {
  const path = yield* Path.Path;
  const paths = yield* findCliProjectPaths(projectRoot, { search: options.search });
  if (paths === null) {
    return null;
  }

  const values: Record<string, string> = ambientProjectEnv();
  const sources: Record<string, "ambient" | ".env" | ".env.local"> = Object.fromEntries(
    Object.keys(values).map((key) => [key, "ambient"]),
  );
  const loadedPaths: string[] = [];
  const env = yield* Config.string("SUPABASE_ENV").pipe(Config.withDefault(defaultSupabaseEnv));

  for (const dir of [paths.supabaseDir, paths.projectRoot]) {
    for (const filename of loadDefaultEnvFilenames(env)) {
      const envPath = path.join(dir, filename);
      const fs = yield* FileSystem.FileSystem;
      const contents = yield* fs
        .readFileString(envPath)
        .pipe(
          Effect.catchTag("PlatformError", (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.map(Effect.void, () => undefined)
              : Effect.fail(functionsServeError("failed to load environment file", cause)),
          ),
        );
      if (contents === undefined) {
        continue;
      }
      loadedPaths.push(envPath);
      const parsed = yield* Effect.try({
        try: () => parseDotEnv(contents),
        catch: (cause) => sanitizeDotEnvParseError(envPath, cause),
      });
      for (const [key, value] of Object.entries(parsed)) {
        if (values[key] !== undefined) {
          continue;
        }
        values[key] = value;
        sources[key] = filename.includes(".local") ? ".env.local" : ".env";
      }
    }
  }

  return { paths, values, loadedPaths, sources } satisfies CliProjectEnvironment;
});

/**
 * Whether any bind mounts something at `containerPath` or below it, i.e. whether
 * that path exists inside the container. Docker creates a missing `--workdir`,
 * but Podman rejects the container outright (supabase/cli#6035), so the flag can
 * only be set for a path a bind actually materializes.
 */
function hasBindUnder(binds: Iterable<DockerBind>, containerPath: string): boolean {
  for (const bind of binds) {
    if (
      bind.containerPath === containerPath ||
      bind.containerPath.startsWith(`${containerPath}/`)
    ) {
      return true;
    }
  }
  return false;
}

const buildWatchSpecs = Effect.fnUntraced(function* (binds: ReadonlyArray<DockerBind>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const specs = new Map<string, WatchSpec>();

  for (const bind of binds) {
    const hostPath = bind.hostPath;
    if (!path.isAbsolute(hostPath)) {
      continue;
    }

    const info = yield* fs.stat(hostPath).pipe(Effect.catchTag("PlatformError", () => Effect.void));
    if (info !== undefined) {
      if (info.type === "Directory") {
        specs.set(hostPath, { root: hostPath, recursive: true });
      } else {
        const root = path.dirname(hostPath);
        const existing = specs.get(root);
        if (existing !== undefined && existing.matchPaths === undefined) {
          continue;
        }
        const matchPaths = new Set(existing?.matchPaths ?? []);
        matchPaths.add(hostPath);
        specs.set(root, { root, recursive: false, matchPaths });
      }
    }
  }

  return [...specs.values()];
});

function shouldIgnoreEvent(pathname: string) {
  const normalized = pathname.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => ignoredDirNames.has(segment))) {
    return true;
  }
  const base = segments[segments.length - 1] ?? normalized;
  return (
    base.endsWith("~") ||
    (base.startsWith(".") && base.endsWith(".swp")) ||
    (base.startsWith(".") && base.endsWith(".swx")) ||
    base.startsWith("___") ||
    base.endsWith(".tmp") ||
    base.startsWith(".#")
  );
}

function eventMatchesSpec(spec: WatchSpec, event: FileWatchEvent) {
  if (shouldIgnoreEvent(event.path)) {
    return false;
  }
  if (spec.matchPaths === undefined) {
    return true;
  }
  return spec.matchPaths.has(event.path);
}

/**
 * File-change op tokens for the established `File change detected: <path>
 * (<OP>)` line. RENAME and CHMOD are unreachable here: `fs.watch` folds
 * renames into create/delete pairs and doesn't report metadata-only changes.
 */
const goFileEventOp = { create: "CREATE", update: "WRITE", delete: "REMOVE" } as const;

const waitForRestartSignal = Effect.fnUntraced(function* (watchSpecs: ReadonlyArray<WatchSpec>) {
  if (watchSpecs.length === 0) {
    return yield* Effect.never;
  }

  const fileWatcher = yield* FileWatcher;
  const output = yield* Output;

  const stream = Stream.mergeAll(
    watchSpecs.map((spec) =>
      fileWatcher
        .watch(spec.root, {
          ignore: watchIgnoreGlobs,
          recursive: spec.recursive,
        })
        .pipe(
          Stream.map((events) => events.filter((event) => eventMatchesSpec(spec, event))),
          Stream.filter((events) => events.length > 0),
        ),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Stream.tap((events) =>
      Effect.forEach(events, (event) =>
        output.raw(
          `File change detected: ${event.path} (${goFileEventOp[event.type]})\n`,
          "stderr",
        ),
      ).pipe(Effect.asVoid),
    ),
    Stream.debounce(Duration.millis(500)),
  );

  const next = yield* Stream.runHead(stream);
  return Option.match(next, {
    onNone: () => Effect.never,
    onSome: () => Effect.void,
  });
});

// One step of Edge Runtime's create → cp → start bring-up. Only the cp step
// passes a `messagePrefix`, since its raw stderr is uninterpretable alone.
const runEdgeRuntimeDockerStep = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  opts: { readonly messagePrefix?: string; readonly stdin?: Stream.Stream<Uint8Array> } = {},
) {
  const result = yield* runChildProcess("docker", args, {
    stdin: opts.stdin,
    stdout: "pipe",
    stderr: "pipe",
  }).pipe(
    Effect.mapError((cause) =>
      functionsServeError("failed to run Edge Runtime Docker step", cause),
    ),
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    const message =
      opts.messagePrefix === undefined
        ? detail || "failed to start edge runtime"
        : detail.length > 0
          ? `${opts.messagePrefix}: ${detail}`
          : opts.messagePrefix;
    return yield* functionsServeError(message);
  }
});

type ContainerLogsEndReason =
  | { readonly _tag: "containerExited" }
  | { readonly _tag: "supervisorTerminated"; readonly exitCode: number }
  | { readonly _tag: "containerGone" };

const writeStoppedServingMessage = Effect.fnUntraced(function* () {
  const output = yield* Output;
  yield* output.raw(`Stopped serving ${styleText("bold", functionsDirName)}\n`, "stdout");
});

/**
 * Distinct from {@link writeStoppedServingMessage}: the container ended the session on its own
 * rather than the user requesting a shutdown, which matters for a `functions serve &` CI step
 * that greps scrollback for whether the runtime is still up.
 */
const writeContainerEndedMessage = Effect.fnUntraced(function* (reason: ContainerLogsEndReason) {
  const output = yield* Output;
  const prefix =
    reason._tag === "containerExited"
      ? "Edge Runtime exited (code 0)."
      : reason._tag === "supervisorTerminated"
        ? `Edge Runtime container stopped (exit ${reason.exitCode}).`
        : "Edge Runtime container is no longer available.";
  yield* output.raw(`${prefix} Stopped serving ${styleText("bold", functionsDirName)}\n`, "stdout");
});

export function buildServeEntrypointCommand(
  command: ReadonlyArray<string>,
  multilineEnvScriptPath?: string,
) {
  // `exec` so edge-runtime is PID 1; sourced env survives into the replacement process.
  return `${multilineEnvScriptPath === undefined ? "" : `. ${multilineEnvScriptPath}\n`}exec ${command.join(" ")}
`;
}

const resolveServeFunctionConfigs = Effect.fnUntraced(function* (
  projectRoot: string,
  supabaseDir: string,
  config: Pick<
    ServeEdgeRuntimeContainerConfig,
    "configDeclaredFunctions" | "configFunctions" | "rawConfigFunctions"
  >,
  importMapOverride: Option.Option<string>,
  noVerifyJwtOverride: Option.Option<boolean>,
  flagCwd: string,
) {
  const slugs = yield* discoverFunctionSlugs(projectRoot, config.configDeclaredFunctions);
  return yield* resolveFunctionConfigs({
    slugs,
    cwd: flagCwd,
    projectRoot,
    supabaseDir,
    configFunctions: config.configFunctions,
    configDeclaredFunctions: config.configDeclaredFunctions,
    rawConfigFunctions: config.rawConfigFunctions,
    importMapOverride,
    noVerifyJwtOverride,
  });
});

/**
 * Docker bind mounts (function source, import map, static assets) for every
 * enabled function under `supabase/functions/**`, called both from Edge
 * Runtime bring-up below and, standalone, from `start`'s Studio container
 * spec, which needs only the bind mounts.
 *
 * Logs `Skipped serving Function: <slug>` unconditionally for every disabled
 * function, so the message double-prints when both Edge Runtime and Studio
 * are enabled — established behavior, not a bug to dedupe.
 *
 * The returned set is not run through `pruneRedundantDockerBinds`: Studio's
 * bring-up never `docker cp`s into its container, and pruning is limited to
 * Edge Runtime's cp path.
 */
export const resolveFunctionBindMounts = Effect.fn("functions.resolveFunctionBindMounts")(
  function* (
    projectId: string,
    projectRoot: string,
    supabaseDir: string,
    config: Pick<
      ServeEdgeRuntimeContainerConfig,
      "configDeclaredFunctions" | "configFunctions" | "rawConfigFunctions"
    >,
    importMapOverride: Option.Option<string>,
    noVerifyJwtOverride: Option.Option<boolean>,
    flagCwd: string,
    projectEnvValues?: Readonly<Record<string, string>>,
  ) {
    const output = yield* Output;
    const path = yield* Path.Path;
    const functionConfigs = yield* resolveServeFunctionConfigs(
      projectRoot,
      supabaseDir,
      config,
      importMapOverride,
      noVerifyJwtOverride,
      flagCwd,
    );

    const functionsDir = path.join(projectRoot, functionsDirName);
    const binds = new Set<string>();
    const bitbucketCloneDirDefined = Option.isSome(yield* bitbucketCloneDir(projectEnvValues));

    for (const fnConfig of functionConfigs) {
      if (!fnConfig.enabled) {
        yield* output.raw(`Skipped serving Function: ${fnConfig.slug}\n`, "stderr");
        continue;
      }

      const bindWarnings: string[] = [];
      for (const bind of yield* buildDockerBinds(projectId, functionsDir, functionsDir, fnConfig, {
        bitbucketCloneDirDefined,
        additionalModuleRoots: [flagCwd],
        skipMissingImportMapTargets: true,
        onWarning: (message) => {
          bindWarnings.push(message);
          return Effect.void;
        },
      })) {
        binds.add(formatDockerBind(bind));
      }
      const missingSourceWarning = bindWarnings.find((warning) =>
        warning.includes("failed to read file:"),
      );
      if (missingSourceWarning !== undefined) {
        return yield* functionsServeError(
          missingSourceWarning.trimStart().replace(/^WARN:\s*/, ""),
        );
      }
    }

    return binds;
  },
);

/**
 * The reusable "bring up one Edge Runtime container" core, called both by
 * the start command and directly
 * by `start`'s own bring-up.
 *
 * Deliberately excludes config-loading (the caller resolves
 * {@link StartEdgeRuntimeContainerInput.config}/`authArtifacts` itself and
 * passes in already-resolved values), file-watching, and log streaming
 * (`serveFunctions`'s own loop still owns those for the standalone command).
 * Also excludes the Kong reload, which is owned by the start command.
 */
export const startEdgeRuntimeContainer = Effect.fn("functions.startEdgeRuntimeContainer")(
  function* (input: StartEdgeRuntimeContainerInput) {
    const output = yield* Output;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const projectId = input.config.projectId;
    const containerId = localDockerId("edge_runtime", projectId);
    const networkMode = input.networkId;
    // Deterministic, persistent host path (not `os.tmpdir()`): `cleanupStartSecrets`
    // (wired into both `stop` and a failed-`start` rollback) reclaims this
    // same tree keyed by container name, so these secret env artifacts don't
    // leak on host disk indefinitely after the container is torn down.
    const stagingDir = path.join(
      input.projectRoot,
      "supabase",
      ".temp",
      "start-secrets",
      containerId,
    );
    // A single directory-wide `rm` (not per-file cleanup closures) covers the
    // whole staging-write window below, including a mid-write failure
    // between two `writeDocker*` calls, not just the final docker steps.
    const removeRuntimeArtifacts = fs
      .remove(stagingDir, { recursive: true, force: true })
      .pipe(
        Effect.mapError((cause) =>
          functionsServeError("failed to clean up Edge Runtime artifacts", cause),
        ),
      );
    const bestEffortCleanupRuntimeArtifacts = removeRuntimeArtifacts.pipe(
      Effect.tapError((error) =>
        output.warn(`Failed to clean up Edge Runtime artifacts: ${error.message}`),
      ),
      Effect.ignoreCause,
    );

    const functionConfigs = yield* resolveServeFunctionConfigs(
      input.projectRoot,
      input.supabaseDir,
      input.config,
      input.importMap,
      input.noVerifyJwt,
      input.flagCwd,
    );

    const functionsDir = path.join(input.projectRoot, functionsDirName);
    const bitbucketCloneDirDefined = Option.isSome(
      yield* bitbucketCloneDir(input.projectEnvValues),
    );
    const functionBinds = new Map<string, DockerBind>();
    const watchableBinds = new Map<string, DockerBind>();
    const emittedScopeWarnings = new Set<string>();
    const functionsConfig: Record<string, ServeFunctionContainerConfig> = {};
    for (const config of functionConfigs) {
      if (!config.enabled) {
        yield* output.raw(`Skipped serving Function: ${config.slug}\n`, "stderr");
        continue;
      }

      const bindWarnings: string[] = [];
      for (const bind of yield* buildDockerBinds(projectId, functionsDir, functionsDir, config, {
        bitbucketCloneDirDefined,
        additionalModuleRoots: [input.flagCwd],
        skipMissingImportMapTargets: true,
        onWarning: (message) => {
          bindWarnings.push(message);
          return Effect.void;
        },
      })) {
        const key = formatDockerBind(bind);
        functionBinds.set(key, bind);
        if (!bind.externalScope) {
          watchableBinds.set(key, bind);
        }
      }
      const missingSourceWarning = bindWarnings.find((warning) =>
        warning.includes("failed to read file:"),
      );
      if (missingSourceWarning !== undefined) {
        return yield* functionsServeError(
          missingSourceWarning.trimStart().replace(/^WARN:\s*/, ""),
        );
      }
      for (const warning of bindWarnings) {
        if (
          warning.startsWith("WARN: Mounting import map scope target") &&
          !emittedScopeWarnings.has(warning)
        ) {
          emittedScopeWarnings.add(warning);
          yield* output.raw(warning, "stderr");
        }
      }
      const functionEnv =
        input.discoverFunctionEnvFiles && Option.isNone(input.envFile)
          ? yield* parseFunctionEnvFile(path.join(functionsDir, config.slug, ".env"))
          : {};
      functionsConfig[config.slug] = toFunctionContainerConfig(
        path,
        input.projectRoot,
        config,
        functionEnv,
      );
    }

    const aggregatedBinds = [...functionBinds.values()];
    // Pruned so the `docker cp` bootstrap below never sees a file bind
    // nested inside a read-only parent bind. The workdir gate below reads
    // the unpruned aggregate on purpose — a pruned bind's container path
    // still exists through its covering parent.
    const binds = pruneRedundantDockerBinds(aggregatedBinds);

    const runtimeVolumePreparation = ensureDockerNamedVolume(
      edgeRuntimeCacheVolume(projectId).name,
      projectId,
      input.projectEnvValues,
    ).pipe(
      Effect.mapError((cause) =>
        functionsServeError("failed to prepare Edge Runtime volume", cause),
      ),
    );
    yield* runtimeVolumePreparation;
    const networkPreparation = ensureDockerNetwork(networkMode, projectId).pipe(
      Effect.mapError((cause) => functionsServeError("failed to prepare Docker network", cause)),
    );
    yield* networkPreparation;

    const env = [
      ...(yield* parseCustomEnvFile(
        input.envFile,
        input.projectRoot,
        input.flagCwd,
        input.config.edgeRuntimeSecrets,
      )),
      "SUPABASE_URL=http://kong:8000",
      `SUPABASE_ANON_KEY=${input.authArtifacts.anonKey}`,
      `SUPABASE_SERVICE_ROLE_KEY=${input.authArtifacts.serviceRoleKey}`,
      `SUPABASE_DB_URL=${input.dbUrl}`,
      `SUPABASE_INTERNAL_PUBLISHABLE_KEY=${input.authArtifacts.publishableKey}`,
      `SUPABASE_INTERNAL_SECRET_KEY=${input.authArtifacts.secretKey}`,
      `SUPABASE_INTERNAL_JWT_SECRET=${input.authArtifacts.jwtSecret}`,
      `SUPABASE_JWKS=${input.authArtifacts.jwks}`,
      `SUPABASE_INTERNAL_HOST_PORT=${input.config.apiPort}`,
      `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${encodeJson(functionsConfig)}`,
      ...(input.debug ? ["SUPABASE_INTERNAL_DEBUG=true"] : []),
    ];
    if (input.inspectMode !== undefined) {
      env.push("SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=0");
    }
    const dockerEnv = Object.fromEntries(env.map(splitEnvEntry));
    const { singleLine: singleLineDockerEnv, multiline: multilineDockerEnv } =
      partitionDockerEnvEntries(dockerEnv);
    // Wrapped in `Effect.onError` below so the whole staging-write window is
    // covered, not just the final docker steps. Container removal on failure
    // stays with the callers, matching `docker run -d` behavior.
    return yield* Effect.gen(function* () {
      yield* Effect.try({
        try: () => validateDockerMultilineEnvNames(multilineDockerEnv),
        catch: (cause) => functionsServeError("invalid multiline environment variable name", cause),
      });
      const dockerEnvFile = yield* writeDockerEnvFile(
        singleLineDockerEnv,
        path.join(stagingDir, "env"),
      );
      const multilineEnvDir = "/root/.supabase/multiline-env";
      const dockerMultilineEnvScript = yield* writeDockerMultilineEnvScript(
        multilineDockerEnv,
        multilineEnvDir,
        path.join(stagingDir, "multiline-env"),
      );

      const labels = dockerProjectLabels(projectId);
      const serveMainFile = `${serveMainDir}/index.ts`;
      const runtimeCommand = [
        "edge-runtime",
        "start",
        `--main-service=${serveMainDir}`,
        `--port=${dockerRuntimeServerPort}`,
        `--policy=${input.config.edgeRuntimePolicy}`,
        ...buildFunctionsServeInspectArgs(input.inspectMode, input.inspectMain),
        ...(input.debug ? ["--verbose"] : []),
      ];
      const serveMainTemplate = yield* getFunctionsServeMainTemplate;
      // Streamed in via `docker cp` between create and start: embedding the template in the
      // `sh -c` argv hits Windows ENAMETOOLONG (#5711), and a single-file host bind mounts as
      // an empty directory on daemons that cannot see this host's filesystem (#6254, #4190).
      const serveMainArchive = yield* containerArchiveBytes({
        [serveMainFile]: serveMainTemplate,
      }).pipe(
        Effect.mapError((cause) =>
          functionsServeError("failed to prepare Edge Runtime bootstrap", cause),
        ),
      );
      const containerProjectRoot = toDockerPath(input.projectRoot);
      const nofile = edgeRuntimeNofileUlimit(input.platform);
      if (nofile.clampWarning !== undefined) {
        yield* output.warn(nofile.clampWarning);
      }
      const command = [
        "create",
        "--name",
        containerId,
        "--network",
        networkMode,
        "--network-alias",
        "edge_runtime",
        ...(hasBindUnder(aggregatedBinds, containerProjectRoot)
          ? ["--workdir", containerProjectRoot]
          : []),
        "--ulimit",
        nofile.arg,
        "--label",
        `com.supabase.cli.project=${labels["com.supabase.cli.project"]}`,
        "--label",
        `com.docker.compose.project=${labels["com.docker.compose.project"]}`,
        "--label",
        `${dockerWorkdirLabel}=${input.projectRoot}`,
        ...binds.flatMap((bind) => ["-v", formatDockerBind(bind)]),
        ...(dockerMultilineEnvScript === undefined ? [] : ["-v", dockerMultilineEnvScript.bind]),
        ...(dockerEnvFile === undefined ? [] : ["--env-file", dockerEnvFile.path]),
        ...(input.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
        ...(input.inspectMode === undefined
          ? []
          : ["-p", `${input.config.edgeRuntimeInspectorPort}:${dockerRuntimeInspectorPort}`]),
        "--entrypoint",
        "sh",
        input.image,
        "-c",
        buildServeEntrypointCommand(runtimeCommand, dockerMultilineEnvScript?.scriptPath),
      ];

      // The container must exist for `docker cp` to have a target, and must not be running
      // yet so edge-runtime never races the copy.
      yield* Effect.uninterruptibleMask((restore) =>
        restore(runEdgeRuntimeDockerStep(command)).pipe(
          Effect.tap(() => Effect.sync(() => input.onContainerCreated?.())),
        ),
      );
      yield* runEdgeRuntimeDockerStep(["cp", "-", `${containerId}:/`], {
        messagePrefix: "failed to copy edge runtime main service into container",
        stdin: Stream.make(serveMainArchive),
      });
      yield* runEdgeRuntimeDockerStep(["start", containerId]);

      return {
        containerId,
        cleanup: removeRuntimeArtifacts.pipe(Effect.orDie),
        watchSpecs: yield* buildWatchSpecs([...watchableBinds.values()]),
      } satisfies StartedRuntime;
    }).pipe(Effect.onError(() => bestEffortCleanupRuntimeArtifacts));
  },
);

const managedFunctionsConfig = (
  config: import("@supabase/stack/effect").StackConfig,
  functions: ReadonlyArray<ResolvedDeployFunctionConfig>,
  inspectMode: FunctionsServeInspectMode | undefined,
  inspectMain: boolean,
  globalEnv: Readonly<Record<string, string>>,
  functionEnv: Readonly<Record<string, Readonly<Record<string, string>>>>,
): EffectServiceConfig<"functions"> => {
  const capability = config.capabilities?.functions;
  const settings = capability?.enabled === false ? undefined : capability?.settings;
  const edgeRuntime = settings?.edge_runtime;
  const configuredSecrets = Object.fromEntries(
    Object.entries(edgeRuntime?.secrets ?? {}).flatMap(([name, value]) => {
      const plain = reveal(value);
      return plain === undefined ? [] : [[name, plain] as const];
    }),
  );
  const inspector =
    inspectMode === undefined ? undefined : { enabled: true as const, port: "auto" as const };
  return {
    enabled: true,
    activation: "eager",
    ...(capability !== undefined && capability.enabled !== false && capability.version !== undefined
      ? { version: capability.version }
      : {}),
    settings: {
      ...settings,
      edge_runtime: {
        ...edgeRuntime,
        secrets: Object.fromEntries(
          Object.entries({ ...configuredSecrets, ...globalEnv }).map(([name, value]) => [
            name,
            Redacted.make(value),
          ]),
        ),
      },
      functions: Object.fromEntries(
        functions.map((entry) => [
          entry.slug,
          {
            enabled: entry.enabled,
            verify_jwt: entry.verifyJwt,
            import_map: entry.importMap,
            entrypoint: entry.entrypoint,
            static_files: [...entry.staticFiles],
            env: Object.fromEntries(
              Object.entries({ ...functionEnv[entry.slug], ...entry.env }).map(([key, value]) => [
                key,
                Redacted.make(value),
              ]),
            ),
          },
        ]),
      ),
      ...(inspectMode === undefined && !inspectMain
        ? {}
        : { inspector: { mode: inspectMode, main: inspectMain } }),
    },
    ...(inspector === undefined ? {} : { endpoints: { inspector } }),
  };
};

const managedFunctionEnvironment = Effect.fnUntraced(function* (
  config: import("@supabase/stack/effect").StackConfig,
  functions: ReadonlyArray<ResolvedDeployFunctionConfig>,
  flags: FunctionsServeFlags,
  dependencies: FunctionsServeDependencies,
) {
  const path = yield* Path.Path;
  const capability = config.capabilities?.functions;
  const settings = capability?.enabled === false ? undefined : capability?.settings;
  const configuredSecrets = Object.fromEntries(
    Object.entries(settings?.edge_runtime?.secrets ?? {}).flatMap(([name, value]) => {
      const plain = reveal(value);
      return plain === undefined ? [] : [[name, plain] as const];
    }),
  );
  const globalEntries = yield* parseCustomEnvFile(
    flags.envFile,
    dependencies.projectRoot,
    dependencies.flagCwd,
    configuredSecrets,
  );
  const globalEnv = Object.fromEntries(globalEntries.map(splitEnvEntry));
  const functionEnv: Record<string, Readonly<Record<string, string>>> = {};
  if (Option.isNone(flags.envFile)) {
    const functionsDir = path.join(dependencies.projectRoot, functionsDirName);
    for (const entry of functions) {
      functionEnv[entry.slug] = {
        ...globalEnv,
        ...(yield* parseFunctionEnvFile(path.join(functionsDir, entry.slug, ".env"))),
      };
    }
  }
  return { globalEnv, functionEnv };
});

const managedFunctionsWatchSpecs = Effect.fnUntraced(function* (
  resolved: ServeResolvedConfig,
  flags: FunctionsServeFlags,
  dependencies: FunctionsServeDependencies,
) {
  const output = yield* Output;
  const path = yield* Path.Path;
  const functionConfigs = yield* resolveServeFunctionConfigs(
    dependencies.projectRoot,
    dependencies.supabaseDir,
    resolved,
    flags.importMap,
    flags.noVerifyJwt,
    dependencies.flagCwd,
  );
  const functionsDir = path.join(dependencies.projectRoot, functionsDirName);
  const binds: DockerBind[] = [];
  const emittedScopeWarnings = new Set<string>();
  const bitbucketCloneDirDefined = Option.isSome(
    yield* bitbucketCloneDir(resolved.projectEnvValues),
  );
  for (const config of functionConfigs) {
    if (!config.enabled) continue;
    const bindWarnings: string[] = [];
    for (const bind of yield* buildDockerBinds(
      resolved.projectId,
      functionsDir,
      functionsDir,
      config,
      {
        bitbucketCloneDirDefined,
        additionalModuleRoots: [dependencies.flagCwd],
        skipMissingImportMapTargets: true,
        onWarning: (message) => {
          bindWarnings.push(message);
          return Effect.void;
        },
      },
    )) {
      if (!bind.externalScope) binds.push(bind);
    }
    const missingSourceWarning = bindWarnings.find((warning) =>
      warning.includes("failed to read file:"),
    );
    if (missingSourceWarning !== undefined) {
      return yield* functionsServeError(missingSourceWarning.trimStart().replace(/^WARN:\s*/, ""));
    }
    for (const warning of bindWarnings) {
      if (
        warning.startsWith("WARN: Mounting import map scope target") &&
        !emittedScopeWarnings.has(warning)
      ) {
        emittedScopeWarnings.add(warning);
        yield* output.raw(warning, "stderr");
      }
    }
  }
  return yield* buildWatchSpecs(binds);
});

interface ManagedFunctionsRuntime {
  readonly service: EffectServiceInstance<"functions">;
  readonly watchSpecs: ReadonlyArray<WatchSpec>;
  readonly observation: FunctionsObservation;
}

interface FunctionsObservation {
  readonly exited: Deferred.Deferred<void>;
  readonly active: Ref.Ref<boolean>;
}

const observeFunctions = Effect.fnUntraced(function* (
  service: EffectServiceInstance<"functions">,
  output: typeof Output.Service,
  observation: FunctionsObservation,
) {
  const signalIfActive = Ref.get(observation.active).pipe(
    Effect.flatMap((active) =>
      active ? Deferred.succeed(observation.exited, undefined) : Effect.void,
    ),
  );
  yield* Effect.forkScoped(
    service.followLogs().pipe(
      Stream.runForEach((entry) =>
        output.raw(entry.message, entry.stream === "stderr" ? "stderr" : "stdout"),
      ),
      Effect.ignoreCause,
      Effect.ensuring(Deferred.succeed(observation.exited, undefined)),
    ),
    { startImmediately: true },
  );
  yield* Effect.forkScoped(
    service.followStatus.pipe(
      Stream.runForEach((status) =>
        status.phase === "failed" || status.phase === "stopped" ? signalIfActive : Effect.void,
      ),
      Effect.ignoreCause,
      Effect.ensuring(signalIfActive),
    ),
    { startImmediately: true },
  );
});

interface ResolvedManagedFunctions {
  readonly resolved: ServeResolvedConfig;
  readonly config: import("@supabase/stack/effect").StackConfig;
  readonly functions: ReadonlyArray<ResolvedDeployFunctionConfig>;
  readonly environment: {
    readonly globalEnv: Readonly<Record<string, string>>;
    readonly functionEnv: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };
  readonly candidateConfig: EffectServiceConfig<"functions">;
}

/**
 * Stack preparation takes the persisted stack view, while the service restart
 * takes the service's concrete config. Keep the candidate conversion in one
 * place so preparation and restart compare the same resolved function inputs.
 */
const managedFunctionsCandidateStackConfig = (
  config: import("@supabase/stack/effect").StackConfig,
  candidate: EffectServiceConfig<"functions">,
): import("@supabase/stack/effect").StackConfig => {
  const inspector = candidate.endpoints?.inspector;
  const inspectorListener =
    inspector === undefined
      ? undefined
      : inspector.enabled === false
        ? { enabled: false as const }
        : {
            enabled: true as const,
            ...(inspector.address === undefined ? {} : { address: inspector.address }),
            ...(typeof inspector.port === "number" ? { port: inspector.port } : {}),
          };
  return {
    ...config,
    capabilities: {
      ...config.capabilities,
      functions: {
        enabled: true,
        ...(candidate.version === undefined ? {} : { version: candidate.version }),
        settings: candidate.settings,
      },
    },
    ...(inspectorListener === undefined
      ? {}
      : {
          listeners: {
            ...config.listeners,
            functionsInspector: inspectorListener,
          },
        }),
  };
};

const resolveManagedFunctions = Effect.fnUntraced(function* (
  flags: FunctionsServeFlags,
  dependencies: FunctionsServeDependencies,
  inspectMode: FunctionsServeInspectMode | undefined,
) {
  const resolved = yield* resolveServeConfig(
    dependencies.projectRoot,
    dependencies.projectIdOverride,
    dependencies.goViperCompat,
    dependencies.goConfigCompat,
  );
  const config = yield* loadStackConfig(dependencies.projectRoot);
  const functions = yield* resolveServeFunctionConfigs(
    dependencies.projectRoot,
    dependencies.supabaseDir,
    resolved,
    flags.importMap,
    flags.noVerifyJwt,
    dependencies.flagCwd,
  );
  const environment = yield* managedFunctionEnvironment(config, functions, flags, dependencies);
  return {
    resolved,
    config,
    functions,
    environment,
    candidateConfig: managedFunctionsConfig(
      config,
      functions,
      inspectMode,
      flags.inspectMain,
      environment.globalEnv,
      environment.functionEnv,
    ),
  } satisfies ResolvedManagedFunctions;
});

const startManagedFunctions = Effect.fnUntraced(function* (
  flags: FunctionsServeFlags,
  dependencies: FunctionsServeDependencies,
  inspectMode: FunctionsServeInspectMode | undefined,
  output: typeof Output.Service,
) {
  const api = yield* StackApi;
  const candidate = yield* resolveManagedFunctions(flags, dependencies, inspectMode);
  const existing = yield* api.findStack({ projectRoot: dependencies.projectRoot });
  const stack = Option.isSome(existing)
    ? yield* api.openStack(existing.value.id)
    : yield* api.createStack({
        projectRoot: dependencies.projectRoot,
        initialConfig: candidate.config,
      });
  // A missing default is a destroyed registration, not a reason for a client
  // to create a replacement under the same name. The supervisor owns default
  // registration and reports the typed not-found failure to this caller.
  const service = yield* stack.services.get({ name: "functions" });
  if (service.service !== "functions") {
    return yield* functionsServeError("stack functions service has an unexpected kind");
  }
  const descriptor = yield* service.describe;
  const prepared = yield* stack.prepare({
    services: [service.id],
    config: managedFunctionsCandidateStackConfig(candidate.config, candidate.candidateConfig),
  });
  const preparedInstance = prepared.instances.find((instance) => instance.id === service.id);
  if (preparedInstance === undefined) {
    return yield* functionsServeError("stack prepare omitted the functions service");
  }
  if (
    descriptor.effectiveConfigFingerprint === undefined ||
    preparedInstance.effectiveConfigFingerprint === undefined
  ) {
    return yield* functionsServeError("stack functions config fingerprint is unavailable");
  }
  const observation: FunctionsObservation = {
    exited: yield* Deferred.make<void>(),
    active: yield* Ref.make(false),
  };
  yield* observeFunctions(service, output, observation);
  if (preparedInstance.effectiveConfigFingerprint !== descriptor.effectiveConfigFingerprint) {
    yield* service.restart({ config: candidate.candidateConfig });
  } else {
    const status = yield* service.status;
    if (status.phase !== "ready" && status.phase !== "starting") yield* service.start;
  }
  yield* Ref.set(observation.active, true);
  return {
    service,
    watchSpecs: yield* managedFunctionsWatchSpecs(candidate.resolved, flags, dependencies),
    observation,
  } satisfies ManagedFunctionsRuntime;
});

const serveManagedFunctions = Effect.fnUntraced(function* (
  flags: FunctionsServeFlags,
  dependencies: FunctionsServeDependencies,
  inspectMode: FunctionsServeInspectMode | undefined,
) {
  const output = yield* Output;
  const processControl = yield* ProcessControl;
  const shutdownRequested = yield* Deferred.make<void>();
  yield* processControl
    .awaitSignal()
    .pipe(
      Effect.andThen(Deferred.succeed(shutdownRequested, void 0)),
      Effect.forkScoped({ startImmediately: true }),
    );
  const startup = yield* Effect.raceFirst(
    Deferred.await(shutdownRequested).pipe(Effect.as({ _tag: "shutdown" as const })),
    startManagedFunctions(flags, dependencies, inspectMode, output).pipe(
      Effect.map((runtime) => ({ _tag: "started" as const, runtime })),
    ),
  );
  if (startup._tag === "shutdown") {
    yield* writeStoppedServingMessage();
    return;
  }
  let runtime = startup.runtime;
  yield* output.raw("Setting up Edge Functions runtime...\n", "stderr");
  for (;;) {
    const outcome = yield* Effect.raceFirst(
      Deferred.await(shutdownRequested).pipe(Effect.as("shutdown" as const)),
      Effect.raceFirst(
        waitForRestartSignal(runtime.watchSpecs).pipe(Effect.as("restart" as const)),
        Deferred.await(runtime.observation.exited).pipe(Effect.as("exited" as const)),
      ),
    );
    if (outcome === "shutdown") {
      yield* writeStoppedServingMessage();
      return;
    }
    if (outcome === "exited") {
      yield* writeContainerEndedMessage({ _tag: "containerGone" });
      return;
    }
    yield* Ref.set(runtime.observation.active, false);
    const restarted = yield* Effect.raceFirst(
      Deferred.await(shutdownRequested).pipe(Effect.as({ _tag: "shutdown" as const })),
      Effect.gen(function* () {
        const candidate = yield* resolveManagedFunctions(flags, dependencies, inspectMode);
        yield* runtime.service.restart({ config: candidate.candidateConfig });
        yield* Ref.set(runtime.observation.active, true);
        return {
          _tag: "restarted" as const,
          runtime: {
            service: runtime.service,
            watchSpecs: yield* managedFunctionsWatchSpecs(candidate.resolved, flags, dependencies),
            observation: runtime.observation,
          } satisfies ManagedFunctionsRuntime,
        };
      }),
    );
    if (restarted._tag === "shutdown") {
      yield* writeStoppedServingMessage();
      return;
    }
    runtime = restarted.runtime;
  }
});

export const serveFunctions = Effect.fn("functions.serve")(function* (
  flags: FunctionsServeFlags,
  dependencies: FunctionsServeDependencies,
) {
  yield* StackApi;
  const inspectMode = yield* Effect.try({
    try: () => {
      const resolvedInspectMode = resolveFunctionsServeInspectMode(flags);
      buildFunctionsServeInspectArgs(resolvedInspectMode, flags.inspectMain);
      return resolvedInspectMode;
    },
    catch: (cause) => functionsServeError("invalid Functions serve inspection flags", cause),
  });
  return yield* Effect.scoped(serveManagedFunctions(flags, dependencies, inspectMode));
});
