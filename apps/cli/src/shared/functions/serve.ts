import {
  ProjectConfigSchema,
  findProjectPaths,
  inferFunctionsManifest,
  loadProjectConfig,
  resolveProjectSubtree,
  resolveProjectValue,
  type ProjectConfig,
  type ProjectEnvironment,
  type ResolvedProjectValue,
  type ResolvedFunctionConfig as ManifestFunctionConfig,
} from "@supabase/config";
import { defaultJwtSecret, defaultPublishableKey, defaultSecretKey } from "@supabase/stack/effect";
import {
  createHmac,
  createPrivateKey,
  sign as signJwtBytes,
  type JsonWebKeyInput,
} from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { styleText } from "node:util";
import { Cause, Duration, Effect, Layer, Option, Queue, Redacted, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { spawnContainerCli } from "../../legacy/shared/legacy-container-cli.ts";
import { legacyGetRegistryImageUrl } from "../../legacy/shared/legacy-docker-registry.ts";
import { parseDotEnv } from "../../legacy/shared/legacy-dotenv.ts";
import {
  resolveRemoteJwks,
  resolveThirdPartyIssuerUrl,
  thirdPartyIssuerUrlUnchecked,
  toPublicJwk,
} from "../auth/jwks.ts";
import { Output } from "../output/output.service.ts";
import {
  FileWatcher,
  FileWatcherError,
  type FileWatchEvent,
} from "../runtime/file-watcher.service.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import {
  buildDockerBinds,
  discoverFunctionSlugs,
  dockerBindHostPath,
  dockerProjectLabels,
  dockerWorkdirLabel,
  ensureDockerNamedVolume,
  ensureDockerNetwork,
  isDockerRunning,
  localDockerId,
  normalizeProjectId,
  rawFunctionConfigRecord,
  resolveEdgeRuntimeVersion,
  resolveFunctionConfigs,
  runChildProcess,
  toDockerPath,
  type ResolvedDeployFunctionConfig,
} from "./deploy.ts";
const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
const defaultProjectConfig = decodeProjectConfig({});

const dockerRuntimeServerPort = 8081;
const dockerRuntimeInspectorPort = 8083;
// Unix timestamp (~2032-11-30) used as the `exp` claim of the local-dev default
// JWTs, matching the Go CLI's hardcoded expiry for anon/service_role tokens.
const defaultJwtExpiry = 1983812996;
const defaultSigningKey = {
  kty: "EC",
  kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
  use: "sig",
  key_ops: ["verify"],
  alg: "ES256",
  ext: true,
  crv: "P-256",
  x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
  y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
} as const;
const functionsDirName = join("supabase", "functions");
const fallbackEnvFilePath = join("supabase", "functions", ".env");
const ignoredDirNames = new Set([
  ".git",
  "node_modules",
  ".vscode",
  ".idea",
  ".DS_Store",
  "vendor",
]);
const dockerLogRetryDelay = Duration.millis(400);
const dockerLogDiagnosticTailLength = 4_096;
const legacyDefaultEdgeRuntimeVersion = "v1.74.2";
const defaultSupabaseEnv = "development";
const serveMainContainerPath = "/root/index.ts";
const shellVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
let cachedLegacyFunctionsServeMainTemplate: string | undefined;
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
const emptyStringArray: ReadonlyArray<string> = [];

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
}

interface PlainServeAuthConfig {
  readonly enabled: boolean;
  readonly signing_keys_path?: string;
  readonly publishable_key?: string;
  readonly secret_key?: string;
  readonly jwt_secret?: string;
  readonly anon_key?: string;
  readonly service_role_key?: string;
  readonly third_party: ProjectConfig["auth"]["third_party"];
}

export interface PlainServeEdgeRuntimeConfig {
  readonly policy: ProjectConfig["edge_runtime"]["policy"];
  readonly inspector_port: number;
  readonly deno_version?: number;
  readonly secrets: Readonly<Record<string, string>>;
}

interface ServeResolvedConfig {
  readonly projectId: string;
  readonly apiPort: number;
  readonly auth: PlainServeAuthConfig;
  readonly edgeRuntime: PlainServeEdgeRuntimeConfig;
  readonly configDeclaredFunctions: Readonly<Record<string, ManifestFunctionConfig>>;
  readonly configFunctions: Readonly<Record<string, ManifestFunctionConfig>>;
  readonly rawConfigFunctions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly configPath?: string;
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
  readonly matchPaths?: ReadonlySet<string>;
}

export interface StartedRuntime {
  readonly containerId: string;
  readonly cleanup: Effect.Effect<void>;
  readonly watchSpecs: ReadonlyArray<WatchSpec>;
}

/**
 * Every already-resolved secret/key {@link startEdgeRuntimeContainer} needs,
 * matching {@link resolveAuthArtifacts}'s return shape. Named and exported so
 * a caller outside this module (`start`'s own edge-runtime bring-up,
 * `legacy/commands/start/services/edge-runtime.service.ts`) can build the
 * exact same shape from values it has already resolved itself, instead of
 * calling {@link resolveAuthArtifacts} (which re-reads `config.toml`/signing
 * keys independently — correct for the standalone `functions serve` command,
 * but would risk resolving different secrets than the rest of a `start`
 * stack for a caller that already has these values).
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
 * beyond auth (see {@link ServeAuthArtifacts}) — a narrowed, exported view of
 * {@link ServeResolvedConfig} (which also carries `auth`/`configPath`, used
 * only to resolve {@link ServeAuthArtifacts} and therefore irrelevant once
 * those are already resolved). `start`'s own bring-up builds this directly
 * from its own already-loaded `ProjectConfig` via {@link toPlainEdgeRuntimeConfig}/
 * {@link toPlainFunctionRecord}/`inferFunctionsManifest` (`@supabase/config`)
 * rather than going through {@link resolveServeConfig}'s independent
 * config-loading pipeline.
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
 * loop, kept independent of BOTH `functions serve`'s own config-loading
 * (`resolveServeConfig`/`resolveAuthArtifacts`) and its file-watch/log-stream
 * loop, so `start`'s bring-up can call it directly with values it has already
 * resolved through its own pipeline (see `internal-db-connection.ts` for why
 * {@link dbUrl} specifically must be caller-supplied rather than hardcoded).
 */
export interface StartEdgeRuntimeContainerInput {
  readonly config: ServeEdgeRuntimeContainerConfig;
  readonly authArtifacts: ServeAuthArtifacts;
  /**
   * `SUPABASE_DB_URL`. Deliberately NOT hardcoded in the shared core: Go's own
   * two callers resolve this differently — standalone `functions serve`
   * (`restartEdgeRuntime`, `serve.go:122`) always uses the `db` network alias
   * (`postgresql://postgres:postgres@db:5432/postgres`, matching
   * {@link legacyDefaultServeDbUrl} below), while `start`'s direct call
   * (`start.go:66-72,1103`) uses the real `dbConfig` — the `db` container's
   * own sanitized name and `config.db.password` — NOT the alias. Every caller
   * must supply its own Go-accurate value; this module does not choose one.
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
  readonly importMap: Option.Option<string>;
  readonly noVerifyJwt: Option.Option<boolean>;
  readonly inspectMode: FunctionsServeInspectMode | undefined;
  readonly inspectMain: boolean;
}

type SigningKeyJwk = JsonWebKeyInput["key"] & {
  readonly kty: "EC" | "RSA";
  readonly kid?: string;
  readonly use?: string;
  readonly ext?: boolean;
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly alg?: "ES256" | "RS256";
  readonly key_ops?: ReadonlyArray<string>;
};

declare const SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE: string | undefined;

export const serveFileWatcherLayer = Layer.sync(FileWatcher, () =>
  FileWatcher.of({
    watch: (root) =>
      Stream.callback<ReadonlyArray<FileWatchEvent>, FileWatcherError>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
              const pathname =
                filename === null || filename === undefined || filename.length === 0
                  ? root
                  : resolve(root, filename.toString());
              Queue.offerUnsafe(queue, [{ path: pathname, type: "update" }]);
            });
            watcher.on("error", (cause) => {
              Queue.failCauseUnsafe(queue, Cause.fail(new FileWatcherError({ path: root, cause })));
            });
            return watcher;
          }),
          (watcher) =>
            Effect.sync(() => {
              watcher.close();
            }),
        ),
      ),
  }),
);

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

function toPlainAuthConfig(
  auth: ProjectConfig["auth"] | ResolvedProjectValue<ProjectConfig["auth"]>,
): PlainServeAuthConfig {
  return {
    enabled: auth.enabled,
    signing_keys_path: reveal(auth.signing_keys_path),
    publishable_key: reveal(auth.publishable_key),
    secret_key: reveal(auth.secret_key),
    jwt_secret: reveal(auth.jwt_secret),
    anon_key: reveal(auth.anon_key),
    service_role_key: reveal(auth.service_role_key),
    third_party: {
      firebase: {
        enabled: auth.third_party.firebase.enabled,
        project_id: reveal(auth.third_party.firebase.project_id),
      },
      auth0: {
        enabled: auth.third_party.auth0.enabled,
        tenant: reveal(auth.third_party.auth0.tenant),
        tenant_region: reveal(auth.third_party.auth0.tenant_region),
      },
      aws_cognito: {
        enabled: auth.third_party.aws_cognito.enabled,
        user_pool_id: reveal(auth.third_party.aws_cognito.user_pool_id),
        user_pool_region: reveal(auth.third_party.aws_cognito.user_pool_region),
      },
      clerk: {
        enabled: auth.third_party.clerk.enabled,
        domain: reveal(auth.third_party.clerk.domain),
      },
      workos: {
        enabled: auth.third_party.workos.enabled,
        issuer_url: reveal(auth.third_party.workos.issuer_url),
      },
    },
  };
}

/**
 * Exported so `start`'s own edge-runtime bring-up
 * (`legacy/commands/start/services/edge-runtime.service.ts`) can reuse this
 * exact `Redacted`-unwrapping/key-uppercasing logic against its own,
 * already-loaded `ProjectConfig` instead of duplicating it — see
 * {@link ServeEdgeRuntimeContainerConfig}'s doc comment.
 */
export function toPlainEdgeRuntimeConfig(
  edgeRuntime: ProjectConfig["edge_runtime"] | ResolvedProjectValue<ProjectConfig["edge_runtime"]>,
): PlainServeEdgeRuntimeConfig {
  return {
    policy: reveal(edgeRuntime.policy) ?? "",
    inspector_port: edgeRuntime.inspector_port,
    deno_version: edgeRuntime.deno_version,
    secrets: Object.fromEntries(
      Object.entries(edgeRuntime.secrets ?? {}).flatMap(([name, value]) =>
        Redacted.isRedacted(value) ? [[name.toUpperCase(), Redacted.value(value)] as const] : [],
      ),
    ),
  };
}

/** Exported for the same reason as {@link toPlainEdgeRuntimeConfig}. */
export function toPlainFunctionRecord(
  functions: ProjectConfig["functions"] | ResolvedProjectValue<ProjectConfig["functions"]>,
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

function normalizeEnvPath(flagCwd: string, pathname: string) {
  return isAbsolute(pathname) ? pathname : resolve(flagCwd, pathname);
}

function encodeBase64Url(input: string) {
  return Buffer.from(input).toString("base64url");
}

function toJsonWebKey(signingKey: SigningKeyJwk): JsonWebKeyInput["key"] {
  return {
    ...signingKey,
    ...(signingKey.key_ops === undefined ? {} : { key_ops: [...signingKey.key_ops] }),
  };
}

function jwtPayload(role: string, exp: number) {
  return JSON.stringify({ iss: "supabase-demo", role, exp });
}

function generateSymmetricJwt(secret: string, role: string) {
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(jwtPayload(role, defaultJwtExpiry));
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function generateAsymmetricJwt(signingKey: SigningKeyJwk, role: string) {
  const algorithm = signingKey.alg;
  if (algorithm !== "ES256" && algorithm !== "RS256") {
    throw new Error(`unsupported algorithm: ${String(algorithm)}`);
  }

  const header = {
    alg: algorithm,
    typ: "JWT",
    ...(signingKey.kid === undefined ? {} : { kid: signingKey.kid }),
  };
  const payload = {
    iss: "supabase-demo",
    role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 10,
  };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const key = createPrivateKey({
    key: toJsonWebKey(signingKey),
    format: "jwk",
  });
  const signature = signJwtBytes("sha256", Buffer.from(data), {
    key,
    ...(algorithm === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}),
  }).toString("base64url");
  return `${data}.${signature}`;
}

async function readSigningKeys(pathname: string): Promise<ReadonlyArray<SigningKeyJwk>> {
  const decoded = JSON.parse(await readFile(pathname, "utf8"));
  if (!Array.isArray(decoded)) {
    throw new Error("expected a JSON array");
  }
  return decoded as ReadonlyArray<SigningKeyJwk>;
}

const resolveAuthArtifacts = Effect.fnUntraced(function* (
  auth: PlainServeAuthConfig,
  configPath: string | undefined,
) {
  const signingKeysPath =
    auth.signing_keys_path === undefined || auth.signing_keys_path.length === 0
      ? ""
      : isAbsolute(auth.signing_keys_path)
        ? auth.signing_keys_path
        : resolve(
            dirname(configPath ?? join(process.cwd(), "supabase", "config.toml")),
            auth.signing_keys_path,
          );

  const signingKeys = yield* Effect.tryPromise({
    try: async () => (signingKeysPath.length === 0 ? [] : await readSigningKeys(signingKeysPath)),
    catch: (cause) => {
      if (cause instanceof SyntaxError) {
        return new Error(`failed to decode signing keys: ${cause.message}`);
      }
      return new Error(
        `failed to read signing keys: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    },
  });

  const jwtSecret =
    auth.jwt_secret === undefined || auth.jwt_secret.length === 0
      ? defaultJwtSecret
      : auth.jwt_secret;
  if (jwtSecret.length < 16) {
    return yield* Effect.fail(
      new Error("Invalid config for auth.jwt_secret. Must be at least 16 characters"),
    );
  }

  const anonKey =
    auth.anon_key === undefined || auth.anon_key.length === 0
      ? signingKeys.length > 0
        ? generateAsymmetricJwt(signingKeys[0]!, "anon")
        : generateSymmetricJwt(jwtSecret, "anon")
      : auth.anon_key;
  const serviceRoleKey =
    auth.service_role_key === undefined || auth.service_role_key.length === 0
      ? signingKeys.length > 0
        ? generateAsymmetricJwt(signingKeys[0]!, "service_role")
        : generateSymmetricJwt(jwtSecret, "service_role")
      : auth.service_role_key;
  const shouldUseJwtSecretFallback = signingKeysPath.length === 0;

  const keys: unknown[] = [];
  // Go's `Auth.ThirdParty.validate()` (the "at most one enabled" + required-field checks
  // `resolveThirdPartyIssuerUrl` performs) only runs inside `Config.Validate`'s `if
  // c.Auth.Enabled` block (`config.go:1087-1153`), but `functions serve`'s own JWKS resolution
  // (`serve.go:141`) discards `ResolveJWKS`'s error unconditionally, regardless of `auth.enabled`.
  // So a malformed/multi-enabled third-party config must not throw here when auth is disabled —
  // use the unchecked, no-throw `IssuerURL()`-only builder instead, matching Go exactly.
  const issuerUrl = auth.enabled
    ? resolveThirdPartyIssuerUrl(auth.third_party)
    : thirdPartyIssuerUrlUnchecked(auth.third_party);
  if (issuerUrl !== undefined) {
    const remoteJwks = yield* Effect.tryPromise({
      try: () => resolveRemoteJwks(issuerUrl),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
    keys.push(...remoteJwks);
  }
  keys.push(
    ...(signingKeys.length > 0
      ? signingKeys.map(toPublicJwk)
      : shouldUseJwtSecretFallback
        ? [defaultSigningKey]
        : []),
  );
  if (shouldUseJwtSecretFallback) {
    keys.push({
      kty: "oct",
      k: Buffer.from(jwtSecret).toString("base64url"),
    });
  }

  return {
    publishableKey:
      auth.publishable_key === undefined || auth.publishable_key.length === 0
        ? defaultPublishableKey
        : auth.publishable_key,
    secretKey:
      auth.secret_key === undefined || auth.secret_key.length === 0
        ? defaultSecretKey
        : auth.secret_key,
    jwtSecret,
    anonKey,
    serviceRoleKey,
    jwks: JSON.stringify({ keys }),
  };
});

const resolveServeConfig = Effect.fnUntraced(function* (
  projectRoot: string,
  projectIdOverride: Option.Option<string>,
  goViperCompat: boolean,
) {
  const projectEnv = yield* loadServeProjectEnvironment(projectRoot);
  const projectRef = Option.match(projectIdOverride, {
    onNone: () => undefined,
    onSome: (value) => {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : undefined;
    },
  });
  // `loadProjectConfig` interpolates `env()` references against the project
  // environment. We resolve that environment ourselves (Go-accurate, layering
  // `.env.<SUPABASE_ENV>`/`.env.local`/`.env` over the ambient env) and pass it
  // in, so loading neither re-reads those files nor mutates `process.env`.
  const loadedConfig = yield* loadProjectConfig(projectRoot, {
    ...(projectRef === undefined ? {} : { projectRef }),
    ...(projectEnv === null ? {} : { projectEnv }),
    goViperCompat,
  });
  const baseConfig = loadedConfig?.config ?? defaultProjectConfig;

  const auth =
    projectEnv === null
      ? toPlainAuthConfig(baseConfig.auth)
      : toPlainAuthConfig(
          yield* resolveProjectSubtree(baseConfig.auth, projectEnv, "auth", { goViperCompat }),
        );
  const edgeRuntime =
    projectEnv === null
      ? toPlainEdgeRuntimeConfig(baseConfig.edge_runtime)
      : toPlainEdgeRuntimeConfig(
          yield* resolveProjectSubtree(baseConfig.edge_runtime, projectEnv, "edge_runtime", {
            goViperCompat,
          }),
        );
  const apiPort =
    projectEnv === null
      ? baseConfig.api.port
      : (yield* resolveProjectSubtree(baseConfig.api, projectEnv, "api", { goViperCompat })).port;
  const configDeclaredFunctions =
    projectEnv === null
      ? toPlainFunctionRecord(baseConfig.functions)
      : toPlainFunctionRecord(
          yield* resolveProjectSubtree(baseConfig.functions, projectEnv, "functions", {
            goViperCompat,
          }),
        );
  const configForManifest: ProjectConfig = {
    ...baseConfig,
    functions: configDeclaredFunctions,
  };
  const configFunctions = yield* inferFunctionsManifest({
    cwd: projectRoot,
    config: configForManifest,
  });
  const configProjectId =
    projectEnv === null
      ? (baseConfig.project_id ?? "")
      : (reveal(
          yield* resolveProjectValue(baseConfig.project_id ?? "", projectEnv, "project_id", {
            goViperCompat,
          }),
        ) ?? "");
  const rawProjectId = Option.getOrElse(projectIdOverride, () => configProjectId).trim();
  const fallbackProjectId = basename(resolve(projectRoot));

  return {
    projectId: normalizeProjectId(rawProjectId.length > 0 ? rawProjectId : fallbackProjectId),
    apiPort,
    auth,
    edgeRuntime,
    configDeclaredFunctions,
    configFunctions,
    rawConfigFunctions: rawFunctionConfigRecord(loadedConfig?.document),
    configPath: loadedConfig?.path,
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

const parseCustomEnvFile = Effect.fnUntraced(function* (
  envFileFlag: Option.Option<string>,
  projectRoot: string,
  flagCwd: string,
  configSecrets: Readonly<Record<string, string>>,
) {
  const output = yield* Output;
  const toEnvEntries = (parsed: Record<string, string>) => {
    const merged = new Map<string, string>(Object.entries(configSecrets));
    for (const [name, value] of Object.entries(parsed)) {
      merged.set(name, value);
    }
    return Effect.forEach([...merged], ([name, value]) => {
      if (name.startsWith("SUPABASE_")) {
        return output
          .raw(`Env name cannot start with SUPABASE_, skipping: ${name}\n`, "stderr")
          .pipe(Effect.as(emptyStringArray));
      }
      return Effect.succeed([`${name}=${value}`] as const);
    }).pipe(Effect.map((entries) => entries.flat()));
  };

  if (Option.isNone(envFileFlag)) {
    const fallbackPath = join(projectRoot, fallbackEnvFilePath);
    const exists = yield* Effect.tryPromise(() =>
      readFile(fallbackPath, "utf8").then(
        (contents) => ({ contents, path: fallbackPath }),
        (error) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
          }
          throw error;
        },
      ),
    );
    if (exists === undefined) {
      return yield* toEnvEntries({});
    }
    const parsed = yield* Effect.try({
      try: () => parseDotEnv(exists.contents),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    return yield* toEnvEntries(parsed);
  }

  const envFilePath = normalizeEnvPath(flagCwd, envFileFlag.value);
  const contents = yield* Effect.tryPromise({
    try: () => readFile(envFilePath, "utf8"),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
  const parsed = yield* Effect.try({
    try: () => parseDotEnv(contents),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
  return yield* toEnvEntries(parsed);
});

function toFunctionContainerConfig(
  workdir: string,
  config: ResolvedDeployFunctionConfig,
): ServeFunctionContainerConfig {
  const toContainerPath = (pathname: string) => {
    const resolvedPath = resolve(pathname);
    const relativePath = relative(workdir, resolvedPath);
    return relativePath.length === 0 ? basename(resolvedPath) : relativePath.replaceAll("\\", "/");
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
    ...(Object.keys(config.env).length === 0 ? {} : { env: config.env }),
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

  // Self-healing: `dir` is a deterministic, reused path (not a fresh mkdtemp
  // each call), so a stale directory from an earlier invocation in the same
  // process (e.g. `functions serve`'s watch-mode restart loop) is removed
  // first — otherwise leftover files from a shrinking env set would survive
  // alongside the fresh write.
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

  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
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
    env.map(([_, value], index) =>
      writeFile(join(hostEnvDir, `env-${index}`), value, { mode: 0o600 }),
    ),
  );
  await writeFile(path, script, { mode: 0o600 });

  return {
    bind: `${dir}:${containerDir}:ro`,
    scriptPath: join(containerDir, scriptName).replaceAll("\\", "/"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
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

function loadDefaultEnvFilenames(env: string) {
  return [`.env.${env}.local`, ...(env === "test" ? [] : [".env.local"]), `.env.${env}`, ".env"];
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

function ambientProjectEnv() {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

const loadServeProjectEnvironment = Effect.fnUntraced(function* (projectRoot: string) {
  const paths = yield* findProjectPaths(projectRoot);
  if (paths === null) {
    return null;
  }

  const values: Record<string, string> = ambientProjectEnv();
  const sources: Record<string, "ambient" | ".env" | ".env.local"> = Object.fromEntries(
    Object.keys(values).map((key) => [key, "ambient"]),
  );
  const loadedPaths: string[] = [];
  const env = process.env["SUPABASE_ENV"] || defaultSupabaseEnv;

  for (const dir of [paths.supabaseDir, paths.projectRoot]) {
    for (const filename of loadDefaultEnvFilenames(env)) {
      const envPath = join(dir, filename);
      const contents = yield* Effect.tryPromise(() =>
        readFile(envPath, "utf8").then(
          (value) => value,
          (error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              return undefined;
            }
            throw error;
          },
        ),
      ).pipe(
        Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
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

  return { paths, values, loadedPaths, sources } satisfies ProjectEnvironment;
});

async function buildWatchSpecs(binds: ReadonlyArray<string>): Promise<ReadonlyArray<WatchSpec>> {
  const specs = new Map<string, WatchSpec>();

  for (const bind of binds) {
    const hostPath = dockerBindHostPath(bind);
    if (!isAbsolute(hostPath)) {
      continue;
    }

    try {
      const info = await stat(hostPath);
      if (info.isDirectory()) {
        specs.set(hostPath, { root: hostPath });
      } else {
        const root = dirname(hostPath);
        const existing = specs.get(root);
        if (existing !== undefined && existing.matchPaths === undefined) {
          continue;
        }
        const matchPaths = new Set(existing?.matchPaths ?? []);
        matchPaths.add(hostPath);
        specs.set(root, { root, matchPaths });
      }
    } catch {
      continue;
    }
  }

  return [...specs.values()];
}

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

const waitForRestartSignal = Effect.fnUntraced(function* (watchSpecs: ReadonlyArray<WatchSpec>) {
  if (watchSpecs.length === 0) {
    return yield* Effect.never;
  }

  const fileWatcher = yield* FileWatcher;
  const output = yield* Output;

  const stream = Stream.mergeAll(
    watchSpecs.map((spec) =>
      fileWatcher.watch(spec.root, { ignore: watchIgnoreGlobs }).pipe(
        Stream.map((events) => events.filter((event) => eventMatchesSpec(spec, event))),
        Stream.filter((events) => events.length > 0),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Stream.tap((events) =>
      Effect.forEach(events, (event) =>
        output.raw(`File change detected: ${event.path} (${event.type})\n`, "stderr"),
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

function forwardByteStream(
  stream: Stream.Stream<Uint8Array, unknown>,
  write: (text: string, stream: "stdout" | "stderr") => Effect.Effect<void>,
  streamName: "stdout" | "stderr",
) {
  const decoder = new TextDecoder();
  return Stream.runForEach(stream, (chunk) =>
    write(decoder.decode(chunk, { stream: true }), streamName),
  ).pipe(Effect.andThen(write(decoder.decode(), streamName)));
}

function isRetriableDockerLogsError(stderr: string) {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("no such container") ||
    normalized.includes("no such object") ||
    normalized.includes("conflict") ||
    normalized.includes("can not get logs from container which is dead or marked for removal")
  );
}

function appendDiagnosticTail(existing: string, text: string) {
  const combined = existing + text;
  return combined.length <= dockerLogDiagnosticTailLength
    ? combined
    : combined.slice(combined.length - dockerLogDiagnosticTailLength);
}

const inspectContainerExitCode = Effect.fnUntraced(function* (containerId: string) {
  const result = yield* runChildProcess(
    "docker",
    ["container", "inspect", "--format", "{{.State.ExitCode}}", containerId],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "failed to inspect container";
    return yield* Effect.fail(new Error(detail));
  }

  const exitCode = Number.parseInt(result.stdout.trim(), 10);
  if (Number.isNaN(exitCode)) {
    return yield* Effect.fail(
      new Error(`failed to parse container exit code: ${result.stdout.trim()}`),
    );
  }

  return exitCode;
});

const streamContainerLogs = Effect.fnUntraced(function* (containerId: string) {
  const output = yield* Output;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  for (;;) {
    const child = yield* spawnContainerCli(spawner, ["logs", "-f", "--timestamps", containerId], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      extendEnv: true,
    });

    let stderrText = "";
    const [exitCode] = yield* Effect.all(
      [
        child.exitCode.pipe(Effect.map(Number)),
        forwardByteStream(child.stdout, (text, stream) => output.raw(text, stream), "stdout"),
        forwardByteStream(
          child.stderr,
          (text, stream) => {
            stderrText = appendDiagnosticTail(stderrText, text);
            return output.raw(text, stream);
          },
          "stderr",
        ),
      ],
      { concurrency: "unbounded" },
    );

    if (exitCode === 0) {
      const containerExitCode = yield* inspectContainerExitCode(containerId);
      if (containerExitCode === 0) {
        return yield* Effect.fail(new Error(`container exited gracefully: ${containerId}`));
      }
      if (containerExitCode === 137) {
        yield* Effect.sleep(dockerLogRetryDelay);
        continue;
      }
      return yield* Effect.fail(new Error(`error running container: exit ${containerExitCode}`));
    }

    const trimmedStderr = stderrText.trim();
    if (!isRetriableDockerLogsError(trimmedStderr)) {
      return yield* Effect.fail(
        new Error(trimmedStderr.length > 0 ? trimmedStderr : `docker logs exited with ${exitCode}`),
      );
    }

    yield* Effect.sleep(dockerLogRetryDelay);
  }
});

const assertLocalDbRunning = Effect.fnUntraced(function* (projectId: string) {
  const dbId = localDockerId("db", projectId);
  const result = yield* runChildProcess("docker", ["container", "inspect", dbId], {
    stdout: "ignore",
    stderr: "pipe",
  }).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));

  if (result.exitCode === 0) {
    return;
  }

  if (result.stderr.includes("No such container") || result.stderr.includes("No such object")) {
    return yield* Effect.fail(new Error("supabase start is not running."));
  }

  return yield* Effect.fail(
    new Error(
      result.stderr.trim().length > 0
        ? `failed to inspect service: ${result.stderr.trim()}`
        : "failed to inspect service",
    ),
  );
});

const bestEffortRemoveContainer = Effect.fnUntraced(function* (containerId: string) {
  yield* runChildProcess("docker", ["container", "rm", "-f", "-v", containerId], {
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(Effect.ignore);
});

const reloadKong = Effect.fnUntraced(function* (projectId: string) {
  const output = yield* Output;
  const kongId = localDockerId("kong", projectId);
  const result = yield* runChildProcess("docker", ["exec", kongId, "kong", "reload"], {
    stdout: "ignore",
    stderr: "pipe",
  }).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));

  if (result.exitCode !== 0) {
    const suffix = result.stderr.trim().length > 0 ? ` ${result.stderr.trim()}` : "";
    yield* output.raw(`Warning: failed to reload Kong:${suffix}\n`, "stderr");
  }
});

const writeStoppedServingMessage = Effect.fnUntraced(function* () {
  const output = yield* Output;
  yield* output.raw(`Stopped serving ${styleText("bold", functionsDirName)}\n`, "stdout");
});

export function buildServeEntrypointCommand(
  command: ReadonlyArray<string>,
  multilineEnvScriptPath?: string,
) {
  return `${multilineEnvScriptPath === undefined ? "" : `. ${multilineEnvScriptPath}\n`}${command.join(" ")}
`;
}

async function writeServeMainTemplateFile(template: string, dir: string) {
  // Mount the bundled runtime template instead of embedding it in `sh -c` so
  // Windows does not hit `uv_spawn` ENAMETOOLONG on path-heavy projects.
  // Self-healing — see the matching comment in `writeDockerEnvFile` above.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pathname = join(dir, "index.ts");
  await writeFile(pathname, template);
  return {
    bind: `${pathname}:${serveMainContainerPath}:ro`,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  } as const;
}

function edgeRuntimeImageTag(version: string) {
  return version.startsWith("v") ? version : `v${version}`;
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
 * enabled function under `supabase/functions/**` — Go's
 * `serve.PopulatePerFunctionConfigs` (`internal/functions/serve/serve.go:
 * 277-318`), called both from Edge Runtime bring-up below (as part of its
 * own loop) and, standalone, from `start`'s Studio container spec
 * (`internal/start/start.go:1149-1159`), which needs only the bind mounts,
 * unconditionally of whether Edge Runtime itself is enabled or excluded.
 * `PopulatePerFunctionConfigs` logs `Skipped serving Function: <slug>`
 * unconditionally for every disabled function, regardless of which of its
 * two callers invoked it — so this shared helper reproduces that logging
 * too. Note this means Go (and this port) genuinely double-prints the
 * message when both Edge Runtime and Studio are enabled, since both call
 * sites fire; don't dedupe it, that would itself diverge from Go.
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
        binds.add(bind);
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

/**
 * The reusable "bring up one Edge Runtime container" core — Go's
 * `ServeFunctions` (`internal/functions/serve/serve.go:135-252`), called both
 * by standalone `functions serve` (indirectly, via `startEdgeRuntime` below,
 * mirroring Go's `restartEdgeRuntime` wrapper) and directly by `start`'s own
 * bring-up (`internal/start/start.go:1101-1108`, no wrapper step in between).
 * Deliberately excludes everything `ServeFunctions` itself excludes too: no
 * config-loading (caller resolves {@link StartEdgeRuntimeContainerInput.config}/
 * {@link StartEdgeRuntimeContainerInput.authArtifacts} itself, matching how
 * Go's two callers each resolve `config.toml`/secrets once, independently, and
 * pass already-resolved values/strings into this shared core — see
 * `serve.go:141-151` vs. `start.go:66-72`), no file-watching, and no log
 * streaming (`serveFunctions`'s own loop, below, still owns both of those for
 * the standalone command). Also excludes the Kong reload: `ServeFunctions`
 * itself never reloads Kong — that only happens in `restartEdgeRuntime`
 * (`startEdgeRuntime` below), after this core succeeds, so `start`'s own
 * bring-up (which calls this core directly) correctly never reloads Kong
 * either.
 */
export const startEdgeRuntimeContainer = Effect.fn("functions.startEdgeRuntimeContainer")(
  function* (input: StartEdgeRuntimeContainerInput) {
    const output = yield* Output;
    const projectId = input.config.projectId;
    const containerId = localDockerId("edge_runtime", projectId);
    const networkMode = input.networkId;
    // Deterministic, persistent host path (matching `start`'s own
    // `legacyStageStartSecretFiles` convention for Kong/Postgres/Supavisor)
    // rather than `os.tmpdir()`: `legacyCleanupStartSecrets` (wired into both
    // `stop` and a failed-`start` rollback) reclaims this same
    // `<workdir>/supabase/.temp/start-secrets/<containerId>` tree keyed by
    // container name, so these JWT/service-role-key/secret env artifacts no
    // longer leak on host disk indefinitely after the container is torn down.
    const stagingDir = join(input.projectRoot, "supabase", ".temp", "start-secrets", containerId);

    const functionConfigs = yield* resolveServeFunctionConfigs(
      input.projectRoot,
      input.supabaseDir,
      input.config,
      input.importMap,
      input.noVerifyJwt,
      input.flagCwd,
    );

    const functionsDir = join(input.projectRoot, functionsDirName);
    const functionBinds = new Set<string>();
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
        functionBinds.add(bind);
      }
      const missingSourceWarning = bindWarnings.find((warning) =>
        warning.includes("failed to read file:"),
      );
      if (missingSourceWarning !== undefined) {
        return yield* Effect.fail(
          new Error(missingSourceWarning.trimStart().replace(/^WARN:\s*/, "")),
        );
      }
      functionsConfig[config.slug] = toFunctionContainerConfig(input.projectRoot, config);
    }

    const binds = new Set(functionBinds);

    yield* ensureDockerNamedVolume(localDockerId("edge_runtime", projectId), projectId);
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
      `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${JSON.stringify(functionsConfig)}`,
      ...(input.debug ? ["SUPABASE_INTERNAL_DEBUG=true"] : []),
    ];
    if (input.inspectMode !== undefined) {
      env.push("SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=0");
    }
    const dockerEnv = Object.fromEntries(env.map(splitEnvEntry));
    const { singleLine: singleLineDockerEnv, multiline: multilineDockerEnv } =
      partitionDockerEnvEntries(dockerEnv);
    yield* Effect.try({
      try: () => validateDockerMultilineEnvNames(multilineDockerEnv),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const dockerEnvFile = yield* Effect.tryPromise(() =>
      writeDockerEnvFile(singleLineDockerEnv, join(stagingDir, "env")),
    );
    const multilineEnvDir = "/root/.supabase/multiline-env";
    const dockerMultilineEnvScript = yield* Effect.tryPromise(() =>
      writeDockerMultilineEnvScript(
        multilineDockerEnv,
        multilineEnvDir,
        join(stagingDir, "multiline-env"),
      ),
    ).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))));

    const labels = dockerProjectLabels(projectId);
    const runtimeCommand = [
      "edge-runtime",
      "start",
      "--main-service=/root",
      `--port=${dockerRuntimeServerPort}`,
      `--policy=${input.config.edgeRuntimePolicy}`,
      ...buildFunctionsServeInspectArgs(input.inspectMode, input.inspectMain),
      ...(input.debug ? ["--verbose"] : []),
    ];
    const serveMainTemplate = yield* Effect.promise(() => getLegacyFunctionsServeMainTemplate());
    const serveMainTemplateFile = yield* Effect.tryPromise(() =>
      writeServeMainTemplateFile(serveMainTemplate, join(stagingDir, "main")),
    ).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))));
    const command = [
      "run",
      "-d",
      "--name",
      containerId,
      "--network",
      networkMode,
      "--network-alias",
      "edge_runtime",
      "--workdir",
      toDockerPath(input.projectRoot),
      "--ulimit",
      "nofile=65536:65536",
      "--label",
      `com.supabase.cli.project=${labels["com.supabase.cli.project"]}`,
      "--label",
      `com.docker.compose.project=${labels["com.docker.compose.project"]}`,
      "--label",
      `${dockerWorkdirLabel}=${input.projectRoot}`,
      "-v",
      serveMainTemplateFile.bind,
      ...([...binds] as ReadonlyArray<string>).flatMap((bind) => ["-v", bind]),
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

    const cleanupRuntimeArtifacts = Effect.all([
      Effect.tryPromise(() => serveMainTemplateFile.cleanup()).pipe(Effect.orDie),
      dockerEnvFile === undefined
        ? Effect.void
        : Effect.tryPromise(() => dockerEnvFile.cleanup()).pipe(Effect.orDie),
      dockerMultilineEnvScript === undefined
        ? Effect.void
        : Effect.tryPromise(() => dockerMultilineEnvScript.cleanup()).pipe(Effect.orDie),
    ]).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* output.raw("Setting up Edge Functions runtime...\n", "stderr");
      const result = yield* runChildProcess("docker", command, {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        yield* cleanupRuntimeArtifacts;
        const message =
          result.stderr.trim() || result.stdout.trim() || "failed to start edge runtime";
        return yield* Effect.fail(new Error(message));
      }

      return {
        containerId,
        cleanup: cleanupRuntimeArtifacts,
        watchSpecs: yield* Effect.promise(() => buildWatchSpecs([...functionBinds])),
      } satisfies StartedRuntime;
    }).pipe(Effect.onInterrupt(() => cleanupRuntimeArtifacts));
  },
);

/**
 * `SUPABASE_DB_URL`'s value for standalone `functions serve` — Go's
 * `restartEdgeRuntime` (`internal/functions/serve/serve.go:121-122`): "Use
 * network alias because Deno cannot resolve `_` in hostname", always
 * `postgresql://postgres:postgres@db:5432/postgres` regardless of
 * project/config (`db`, `utils.DbAliases[0]`, is a fixed network alias, and
 * `db.Password` is `toml:"-"` — never configurable, always the `"postgres"`
 * literal default, `pkg/config/config.go:459`). This is genuinely NOT the
 * same value `start`'s own bring-up uses — see
 * {@link StartEdgeRuntimeContainerInput.dbUrl}'s doc comment.
 */
const legacyDefaultServeDbUrl = "postgresql://postgres:postgres@db:5432/postgres";

/**
 * Go's `restartEdgeRuntime` (`internal/functions/serve/serve.go:108-133`):
 * resolves `functions serve`'s own config/secrets/image independently on
 * every (re)start, then delegates the actual bring-up to
 * {@link startEdgeRuntimeContainer} (Go's `ServeFunctions`) exactly like
 * `start`'s own bring-up will. Once that bring-up succeeds, this wrapper — and
 * only this wrapper, matching Go's `restartEdgeRuntime` — reloads Kong
 * (`serve.go:126-131`) so Kong's routing table picks up the freshly
 * (re)started container.
 */
const startEdgeRuntime = Effect.fnUntraced(function* (input: {
  readonly flags: FunctionsServeFlags;
  readonly dependencies: FunctionsServeDependencies;
  readonly debug: boolean;
  readonly networkId: Option.Option<string>;
  readonly inspectMode: FunctionsServeInspectMode | undefined;
}) {
  if (!(yield* isDockerRunning())) {
    return yield* Effect.fail(
      new Error(
        "failed to run docker. Docker Desktop is a prerequisite for local development. Follow the official docs to install: https://docs.docker.com/desktop",
      ),
    );
  }

  const resolved = yield* resolveServeConfig(
    input.dependencies.projectRoot,
    input.dependencies.projectIdOverride,
    input.dependencies.goViperCompat,
  );
  const projectId = resolved.projectId;
  const containerId = localDockerId("edge_runtime", projectId);
  let ownsRuntime = false;
  return yield* Effect.gen(function* () {
    const networkMode = Option.getOrElse(input.networkId, () =>
      localDockerId("network", projectId),
    );
    const authArtifacts = yield* resolveAuthArtifacts(resolved.auth, resolved.configPath);
    const edgeRuntimeVersionOverride = yield* Effect.tryPromise(() =>
      readFile(join(input.dependencies.supabaseDir, ".temp", "edge-runtime-version"), "utf8"),
    ).pipe(
      Effect.map((value) => value.trim()),
      Effect.catch(() => Effect.succeed("")),
      Effect.map((value) => value || legacyDefaultEdgeRuntimeVersion),
    );
    const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersion(
      resolved.edgeRuntime.deno_version,
      edgeRuntimeVersionOverride,
    );
    const image = legacyGetRegistryImageUrl(
      `supabase/edge-runtime:${edgeRuntimeImageTag(edgeRuntimeVersion)}`,
    );

    yield* assertLocalDbRunning(projectId);
    yield* bestEffortRemoveContainer(containerId);
    ownsRuntime = true;

    const startedRuntime = yield* startEdgeRuntimeContainer({
      config: {
        projectId,
        apiPort: resolved.apiPort,
        edgeRuntimePolicy: resolved.edgeRuntime.policy,
        edgeRuntimeInspectorPort: resolved.edgeRuntime.inspector_port,
        edgeRuntimeSecrets: resolved.edgeRuntime.secrets,
        configDeclaredFunctions: resolved.configDeclaredFunctions,
        configFunctions: resolved.configFunctions,
        rawConfigFunctions: resolved.rawConfigFunctions,
      },
      authArtifacts,
      dbUrl: legacyDefaultServeDbUrl,
      image,
      projectRoot: input.dependencies.projectRoot,
      supabaseDir: input.dependencies.supabaseDir,
      flagCwd: input.dependencies.flagCwd,
      platform: input.dependencies.platform,
      debug: input.debug,
      networkId: networkMode,
      envFile: input.flags.envFile,
      importMap: input.flags.importMap,
      noVerifyJwt: input.flags.noVerifyJwt,
      inspectMode: input.inspectMode,
      inspectMain: input.flags.inspectMain,
    });

    yield* reloadKong(projectId);

    return startedRuntime;
  }).pipe(
    Effect.onInterrupt(() => (ownsRuntime ? bestEffortRemoveContainer(containerId) : Effect.void)),
  );
});

export const serveFunctions = Effect.fn("functions.serve")(function* (
  flags: FunctionsServeFlags,
  dependencies: FunctionsServeDependencies,
) {
  const processControl = yield* ProcessControl;
  const inspectMode = yield* Effect.try({
    try: () => {
      const resolvedInspectMode = resolveFunctionsServeInspectMode(flags);
      buildFunctionsServeInspectArgs(resolvedInspectMode, flags.inspectMain);
      return resolvedInspectMode;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

  const loop = Effect.gen(function* () {
    for (;;) {
      const startOutcome = yield* Effect.raceFirst(
        processControl.awaitSignal().pipe(Effect.as("shutdown" as const)),
        startEdgeRuntime({
          flags,
          dependencies,
          debug: dependencies.debug,
          networkId: dependencies.networkId,
          inspectMode,
        }).pipe(Effect.map((started) => ({ _tag: "started" as const, started }))),
      );

      if (startOutcome === "shutdown") {
        yield* writeStoppedServingMessage();
        return;
      }

      const started = startOutcome.started;

      // `streamContainerLogs` never succeeds: it streams logs until the container
      // exits, then fails. A container crash therefore propagates out of this race
      // and terminates `serve` — the Go CLI never auto-restarts a crashed container.
      // The race only ever resolves to "shutdown" (signal) or "restart" (file change).
      const outcome = yield* Effect.raceFirst(
        Effect.raceFirst(
          processControl.awaitSignal().pipe(Effect.as("shutdown" as const)),
          waitForRestartSignal(started.watchSpecs).pipe(Effect.as("restart" as const)),
        ),
        streamContainerLogs(started.containerId),
      ).pipe(
        Effect.ensuring(
          bestEffortRemoveContainer(started.containerId).pipe(Effect.ensuring(started.cleanup)),
        ),
      );

      if (outcome === "shutdown") {
        yield* writeStoppedServingMessage();
        return;
      }
    }
  });

  yield* Effect.scoped(loop);
});
