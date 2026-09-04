import {
  type CliConfig,
  type ResolvedCliConfigValue,
  type ResolvedFunctionConfig as ManifestFunctionConfig,
} from "@supabase/config/effect";
import { edgeRuntimeNofileUlimit } from "../stack-constants.ts";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect, Option, Redacted, Stream } from "effect";
import { parseDotEnv } from "../../legacy/shared/legacy-dotenv.ts";
import { Output } from "../output/output.service.ts";
import {
  buildDockerBinds,
  discoverFunctionSlugs,
  type DockerBind,
  formatDockerBind,
  dockerWorkdirLabel,
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
  runChildProcess,
  toDockerPath,
} from "./functions-docker.ts";
import { FUNCTIONS_CONTAINER_ROOT } from "./serve-main-deps.ts";

const dockerRuntimeServerPort = 8081;
const dockerRuntimeInspectorPort = 8083;
const functionsDirName = join("supabase", "functions");
const fallbackEnvFilePath = join("supabase", "functions", ".env");
const serveMainDir = "/root";
const shellVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
let cachedLegacyFunctionsServeMainTemplate: string | undefined;

const FUNCTIONS_SERVE_INSPECT_MODES = ["run", "brk", "wait"] as const;

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

export interface PlainServeEdgeRuntimeConfig {
  readonly policy: CliConfig["edge_runtime"]["policy"];
  readonly inspector_port: number;
  readonly deno_version?: number;
  readonly secrets: Readonly<Record<string, string>>;
}

interface ServeFunctionContainerConfig {
  readonly verifyJWT: boolean;
  readonly entrypointPath: string;
  readonly importMapPath?: string;
  readonly staticFiles?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface StartedRuntime {
  readonly containerId: string;
  readonly cleanup: Effect.Effect<void>;
}

/**
 * Every already-resolved secret/key {@link startEdgeRuntimeContainer} needs,
 * matching {@link finalizeAuthArtifacts}'s return shape. Named and exported so
 * the legacy start bring-up can build the exact same shape from values it has
 * already resolved, without reading `config.toml` or signing keys a second time.
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
 * beyond auth (see {@link ServeAuthArtifacts}). The legacy start bring-up
 * builds this directly from its already-loaded `CliConfig`.
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
 * Input to {@link startEdgeRuntimeContainer}, the reusable "bring up one
 * Edge Runtime container" core used by the legacy start bring-up. Config and
 * secrets are resolved by the caller (see `internal-db-connection.ts` for why
 * {@link dbUrl} must be caller-supplied rather than hardcoded).
 */
export interface StartEdgeRuntimeContainerInput {
  readonly onContainerCreated?: () => void;
  readonly config: ServeEdgeRuntimeContainerConfig;
  readonly authArtifacts: ServeAuthArtifacts;
  /**
   * `SUPABASE_DB_URL`. Deliberately not hardcoded in the shared core: the
   * caller supplies the database URL matching its resolved runtime topology.
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
  /** Whether to load each function's local `.env` file; legacy start passes false. */
  readonly discoverFunctionEnvFiles: boolean;
  readonly importMap: Option.Option<string>;
  readonly noVerifyJwt: Option.Option<boolean>;
  readonly inspectMode: FunctionsServeInspectMode | undefined;
  readonly inspectMain: boolean;
}

declare const SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE: string | undefined;

/**
 * `serve.main.ts` runs verbatim as a Deno entrypoint inside the edge-runtime
 * container (written to `/root/index.ts`). It is bundled into a single
 * self-contained module so its `jose` and local helper dependencies are inlined and
 * the runtime needs no network access on start (supabase/supabase#45570).
 *
 * Compiled builds embed the pre-bundled template via the
 * `SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE` define (see `scripts/build.ts`), so the
 * shipped binary never bundles at runtime. Running from source (`bun src/supabase.ts`)
 * bundles on demand.
 */
function getLegacyFunctionsServeMainTemplate(): Promise<string> {
  if (cachedLegacyFunctionsServeMainTemplate !== undefined) {
    return Promise.resolve(cachedLegacyFunctionsServeMainTemplate);
  }
  if (typeof SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE === "string") {
    cachedLegacyFunctionsServeMainTemplate = SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE;
    return Promise.resolve(cachedLegacyFunctionsServeMainTemplate);
  }
  // Running from source: the build-time define is absent, so bundle on demand. The
  // bundler (and its esbuild dependency) is imported lazily and only here, so it is
  // never loaded by shipped binaries — which always take the define branch above.
  return import("./serve-main-bundler.ts")
    .then(({ bundleServeMainTemplate }) => bundleServeMainTemplate())
    .then((bundled) => {
      cachedLegacyFunctionsServeMainTemplate = bundled;
      return bundled;
    });
}

function reveal(value: string | Redacted.Redacted<string> | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
}

/**
 * Exported so `start`'s own edge-runtime bring-up
 * (`legacy/commands/start/services/edge-runtime.service.ts`) can reuse this
 * exact `Redacted`-unwrapping/zero-hash-filtering logic against its own,
 * already-loaded `CliConfig` instead of duplicating it — see
 * {@link ServeEdgeRuntimeContainerConfig}'s doc comment.
 */
export function toPlainEdgeRuntimeConfig(
  edgeRuntime: CliConfig["edge_runtime"] | ResolvedCliConfigValue<CliConfig["edge_runtime"]>,
): PlainServeEdgeRuntimeConfig {
  return {
    policy: reveal(edgeRuntime.policy) ?? "",
    inspector_port: edgeRuntime.inspector_port,
    deno_version: edgeRuntime.deno_version,
    // Go's config loader rewrites every `[edge_runtime.secrets]` key with
    // `strings.ToUpper` (`pkg/config/config.go:766-771`, the viper #1014
    // workaround) before `set.ListSecrets`
    // (`internal/secrets/set/set.go:48-52`) reads the map, so secret names
    // always reach the container env UPPERCASED regardless of authored
    // casing. ListSecrets then keeps only entries with a non-empty SHA256:
    // `DecryptSecretHookFunc` (`pkg/config/secret.go:94-107`) leaves the
    // SHA256 empty exactly when the value is empty or a still-unresolved
    // `env(VAR)` literal. In the TS pipeline `resolveCliConfigSubtree` wraps
    // resolved secret leaves in `Redacted` and leaves unresolved `env()`
    // literals as plain strings, so `Redacted.isRedacted` + non-empty mirrors
    // both zero-hash cases — the same guard `secrets set` uses
    // (`legacy/commands/secrets/set/set.handler.ts`).
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

function normalizeEnvPath(flagCwd: string, pathname: string) {
  return isAbsolute(pathname) ? pathname : resolve(flagCwd, pathname);
}

const readDotEnvFile = Effect.fnUntraced(function* (pathname: string, optional: boolean) {
  const contents = yield* Effect.tryPromise({
    try: () =>
      readFile(pathname, "utf8").then(
        (value) => value,
        (error) => {
          if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
          }
          throw error;
        },
      ),
    catch: (cause) =>
      new Error(
        `failed to load environment file: ${pathname}${cause instanceof Error ? ` (${cause.message})` : ""}`,
        { cause },
      ),
  });
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
  const envFilePath = Option.match(envFileFlag, {
    onNone: () => join(projectRoot, fallbackEnvFilePath),
    onSome: (pathname) => normalizeEnvPath(flagCwd, pathname),
  });
  const parsed = yield* readDotEnvFile(envFilePath, Option.isNone(envFileFlag));
  const filtered = yield* filterCustomEnv({ ...configSecrets, ...parsed });
  return Object.entries(filtered).map(([name, value]) => `${name}=${value}`);
});

const parseFunctionEnvFile = Effect.fnUntraced(function* (pathname: string) {
  return yield* readDotEnvFile(pathname, true).pipe(Effect.flatMap(filterCustomEnv));
});

function toFunctionContainerConfig(
  config: ResolvedDeployFunctionConfig,
  envFile: Readonly<Record<string, string>>,
  pathMappings: ReadonlyArray<{ readonly hostRoot: string; readonly containerRoot: string }>,
): ServeFunctionContainerConfig {
  const toContainerPath = (pathname: string) => {
    const resolvedPath = resolve(pathname);
    for (const mapping of pathMappings) {
      const relativePath = relative(mapping.hostRoot, resolvedPath);
      if (
        relativePath === "" ||
        (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
      ) {
        return join(mapping.containerRoot, relativePath).replaceAll("\\", "/");
      }
    }
    return toDockerPath(resolvedPath);
  };

  return {
    // The Go serve path defaults verifyJWT to true when verify_jwt is not set in
    // config.toml (serve.go: `verifyJWT := true; if fc.VerifyJWT != nil { ... }`),
    // unlike deploy which omits it. Mirror that default here.
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

async function writeDockerEnvFile(env: Readonly<Record<string, string>>, dir: string) {
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return undefined;
  }

  // Self-healing: `dir` is deterministic and reused across invocations, so
  // remove any stale files before writing a shrinking environment set.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "docker.env");
  // The file holds the JWT secret, anon/service-role keys, and JWKS, so keep it
  // owner-only rather than relying on the process umask.
  await writeFile(
    path,
    entries
      .map(([name, value]) => `${name}=${value.replaceAll("\r", "\\r").replaceAll("\n", "\\n")}`)
      .join("\n"),
    { mode: 0o600 },
  );

  return { path };
}

async function writeDockerMultilineEnvScript(
  env: ReadonlyArray<readonly [string, string]>,
  containerDir: string,
  dir: string,
) {
  // Self-healing — see the matching comment in `writeDockerEnvFile` above.
  // Runs unconditionally, before the `env.length === 0` check, so a stale
  // directory left by an earlier invocation that DID need multiline secrets
  // is still reclaimed even when the current invocation doesn't.
  await rm(dir, { recursive: true, force: true });

  if (env.length === 0) {
    return undefined;
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const scriptName = "multiline-env.sh";
  const path = join(dir, scriptName);
  const envDir = join(containerDir, "values");
  const hostEnvDir = join(dir, "values");
  // Names are validated by `validateDockerMultilineEnvNames` before this runs.
  const script = env
    .map(([name], index) => {
      const valueFile = `env-${index}`;
      const valuePath = join(envDir, valueFile).replaceAll("\\", "/");
      return `${name}="$(cat ${valuePath}; printf x)"
export ${name}="\${${name}%x}"`;
    })
    .join("\n");
  await mkdir(hostEnvDir, { recursive: true, mode: 0o700 });
  // The value files hold secret env values, so keep them owner-only.
  await Promise.all(
    env.map(([, value], index) =>
      writeFile(join(hostEnvDir, `env-${index}`), value, { mode: 0o600 }),
    ),
  );
  await writeFile(path, script, { mode: 0o600 });

  return {
    // `Z`: private SELinux relabel of this CLI-staged dir (supabase/cli#5989);
    // single-consumer bind, no-op without SELinux.
    bind: `${dir}:${containerDir}:ro,Z`,
    scriptPath: join(containerDir, scriptName).replaceAll("\\", "/"),
  };
}

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

function sanitizeDotEnvParseError(path: string, cause: unknown) {
  if (!(cause instanceof Error)) {
    return new Error(`failed to parse environment file: ${path}`);
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
        return new Error(
          `failed to parse environment file: ${path} (unexpected character '${char}' in variable name)`,
        );
      }
    }
    return new Error(
      `failed to parse environment file: ${path} (unexpected character in variable name)`,
    );
  }
  if (message.startsWith("unterminated quoted value")) {
    return new Error(`failed to parse environment file: ${path} (unterminated quoted value)`);
  }
  if (message.includes("\n")) {
    return new Error(`failed to parse environment file: ${path} (syntax error)`);
  }
  return new Error(`failed to load ${path}: ${message}`);
}

/** Whether any bind mounts something at `containerPath` or below it. */
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
 * enabled function under `supabase/functions/**`. Both the legacy Edge Runtime
 * and Studio bring-ups use this helper, so disabled-function diagnostics are
 * emitted consistently for either caller.
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
  ) {
    const output = yield* Output;
    const functionConfigs = yield* resolveServeFunctionConfigs(
      projectRoot,
      supabaseDir,
      config,
      importMapOverride,
      noVerifyJwtOverride,
      flagCwd,
    );

    const functionsDir = join(projectRoot, functionsDirName);
    const binds = new Set<string>();

    for (const fnConfig of functionConfigs) {
      if (!fnConfig.enabled) {
        yield* output.raw(`Skipped serving Function: ${fnConfig.slug}\n`, "stderr");
        continue;
      }

      const bindWarnings: string[] = [];
      for (const bind of yield* Effect.promise(() =>
        buildDockerBinds(projectId, functionsDir, functionsDir, fnConfig, {
          additionalModuleRoots: [flagCwd],
          skipMissingImportMapTargets: true,
          onWarning: async (message) => {
            bindWarnings.push(message);
          },
        }),
      )) {
        binds.add(formatDockerBind(bind));
      }
      const missingSourceWarning = bindWarnings.find((warning) =>
        warning.includes("failed to read file:"),
      );
      if (missingSourceWarning !== undefined) {
        return yield* Effect.fail(
          new Error(missingSourceWarning.trimStart().replace(/^WARN:\s*/, "")),
        );
      }
    }

    return binds;
  },
);

// One step of Edge Runtime's create → cp → start bring-up. Only the cp step passes a
// `messagePrefix` — its raw stderr is uninterpretable alone — while create/start keep the
// `docker run -d` era stderr surface byte-identical.
const runEdgeRuntimeDockerStep = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  opts: { readonly messagePrefix?: string; readonly stdin?: Stream.Stream<Uint8Array> } = {},
) {
  const result = yield* runChildProcess("docker", args, {
    stdin: opts.stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    const message =
      opts.messagePrefix === undefined
        ? detail || "failed to start edge runtime"
        : detail.length > 0
          ? `${opts.messagePrefix}: ${detail}`
          : opts.messagePrefix;
    return yield* Effect.fail(new Error(message));
  }
});

/**
 * Reusable Edge Runtime container bring-up used by the legacy start path.
 * Config, secrets, file watching, and log streaming remain outside this core;
 * Kong reload is also owned by the caller after this operation succeeds.
 */
export const startEdgeRuntimeContainer = Effect.fn("functions.startEdgeRuntimeContainer")(
  function* (input: StartEdgeRuntimeContainerInput) {
    const output = yield* Output;
    const projectId = input.config.projectId;
    const containerId = localDockerId("edge_runtime", projectId);
    const networkMode = input.networkId;
    // Deterministic, persistent host path (the same `<workdir>/supabase/.temp/start-secrets/`
    // convention `start`'s own container-lifecycle bring-up used to stage Kong/Postgres/
    // Supavisor's `secretFiles` on host disk before they moved to `docker cp` delivery —
    // see `legacyCopyStartSecretFilesIntoContainer`'s doc comment, `container-lifecycle.ts`)
    // rather than `os.tmpdir()`: `legacyCleanupStartSecrets` (wired into both `stop` and a
    // failed-`start` rollback) reclaims this same `<workdir>/supabase/.temp/start-secrets/
    // <containerId>` tree keyed by container name, so these JWT/service-role-key/secret env
    // artifacts no longer leak on host disk indefinitely after the container is torn down.
    const stagingDir = join(input.projectRoot, "supabase", ".temp", "start-secrets", containerId);
    // A single directory-wide `rm` rather than per-file `.cleanup()` closures (the JWT
    // secrets/env file and the multiline-env script both live under `stagingDir`): this is
    // what lets the cleanup cover the whole staging-write window below, including a mid-write
    // failure between the first and second `writeDocker*` call, not just the final docker
    // create/cp/start steps.
    const removeRuntimeArtifacts = Effect.tryPromise({
      try: () => rm(stagingDir, { recursive: true, force: true }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
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

    const functionsDir = join(input.projectRoot, functionsDirName);
    const functionsRoot = resolve(functionsDir);
    const containerFunctionsRoot = FUNCTIONS_CONTAINER_ROOT;
    const canonicalFunctionsRoot = yield* Effect.promise(() =>
      realpath(functionsRoot).catch(() => functionsRoot),
    );
    const pathMappings = [
      { hostRoot: functionsRoot, containerRoot: containerFunctionsRoot },
      ...(canonicalFunctionsRoot === functionsRoot
        ? []
        : [{ hostRoot: canonicalFunctionsRoot, containerRoot: containerFunctionsRoot }]),
    ];
    const functionBinds = new Map<string, DockerBind>();
    const emittedScopeWarnings = new Set<string>();
    const functionsConfig: Record<string, ServeFunctionContainerConfig> = {};
    for (const config of functionConfigs) {
      if (!config.enabled) {
        yield* output.raw(`Skipped serving Function: ${config.slug}\n`, "stderr");
        continue;
      }

      const bindWarnings: string[] = [];
      for (const bind of yield* Effect.promise(() =>
        buildDockerBinds(projectId, functionsDir, functionsDir, config, {
          additionalModuleRoots: [input.flagCwd],
          skipMissingImportMapTargets: true,
          onWarning: async (message) => {
            bindWarnings.push(message);
          },
        }),
      )) {
        const mappedBind =
          resolve(bind.hostPath) === functionsRoot
            ? { ...bind, containerPath: containerFunctionsRoot }
            : bind;
        const key = formatDockerBind(mappedBind);
        functionBinds.set(key, mappedBind);
      }
      const missingSourceWarning = bindWarnings.find((warning) =>
        warning.includes("failed to read file:"),
      );
      if (missingSourceWarning !== undefined) {
        return yield* Effect.fail(
          new Error(missingSourceWarning.trimStart().replace(/^WARN:\s*/, "")),
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
          ? yield* parseFunctionEnvFile(join(functionsDir, config.slug, ".env"))
          : {};
      functionsConfig[config.slug] = toFunctionContainerConfig(config, functionEnv, pathMappings);
    }

    const binds = [...functionBinds.values()];

    yield* ensureDockerNamedVolume(edgeRuntimeCacheVolume(projectId).name, projectId);
    yield* ensureDockerNetwork(networkMode, projectId);

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
      `SUPABASE_INTERNAL_FUNCTIONS_ROOT=${containerFunctionsRoot}`,
      `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${JSON.stringify(functionsConfig)}`,
      ...(input.debug ? ["SUPABASE_INTERNAL_DEBUG=true"] : []),
    ];
    if (input.inspectMode !== undefined) {
      env.push("SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=0");
    }
    const dockerEnv = Object.fromEntries(env.map(splitEnvEntry));
    const { singleLine: singleLineDockerEnv, multiline: multilineDockerEnv } =
      partitionDockerEnvEntries(dockerEnv);
    // Everything from here on writes into `stagingDir` (or starts the container that reads from
    // it), so the whole window — including a mid-write failure between two `writeDocker*` calls,
    // not just the final docker create/cp/start steps — is wrapped in `Effect.onError` below.
    // Container removal on failure stays with the callers, matching `docker run -d` behavior.
    return yield* Effect.gen(function* () {
      yield* Effect.try({
        try: () => validateDockerMultilineEnvNames(multilineDockerEnv),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      const dockerEnvFile = yield* Effect.tryPromise({
        try: () => writeDockerEnvFile(singleLineDockerEnv, join(stagingDir, "env")),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      const multilineEnvDir = "/root/.supabase/multiline-env";
      const dockerMultilineEnvScript = yield* Effect.tryPromise({
        try: () =>
          writeDockerMultilineEnvScript(
            multilineDockerEnv,
            multilineEnvDir,
            join(stagingDir, "multiline-env"),
          ),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });

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
      const serveMainTemplate = yield* Effect.promise(() => getLegacyFunctionsServeMainTemplate());
      // Streamed in via `docker cp` between create and start: embedding the template in the
      // `sh -c` argv hits Windows ENAMETOOLONG (#5711), and a single-file host bind mounts as
      // an empty directory on daemons that cannot see this host's filesystem (#6254, #4190).
      const serveMainArchive = yield* Effect.tryPromise({
        try: () => containerArchiveBytes({ [serveMainFile]: serveMainTemplate }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
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
        ...(hasBindUnder(binds, containerProjectRoot) ? ["--workdir", containerProjectRoot] : []),
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
      } satisfies StartedRuntime;
    }).pipe(Effect.onError(() => bestEffortCleanupRuntimeArtifacts));
  },
);
