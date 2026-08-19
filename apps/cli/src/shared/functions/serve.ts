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
import { existsSync, watch } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { styleText } from "node:util";
import { Cause, Duration, Effect, Layer, Option, Queue, Redacted, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  legacyDescribeContainerCliFailure,
  spawnContainerCli,
} from "../../legacy/shared/legacy-container-cli.ts";
import {
  LEGACY_SUGGEST_DOCKER_INSTALL,
  legacyIsDockerDaemonUnreachable,
} from "../../legacy/shared/legacy-docker-suggest.ts";
import { parseDotEnv } from "../../legacy/shared/legacy-dotenv.ts";
import { legacyViperEnvStringWithProjectFallback } from "../legacy/legacy-viper-env.ts";
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
  dockerBindContainerPath,
  dockerBindHostPath,
  dockerWorkdirLabel,
  rawFunctionConfigRecord,
  resolveFunctionConfigs,
  type ResolvedDeployFunctionConfig,
} from "./deploy.ts";
import {
  containerArchiveBytes,
  dockerProjectLabels,
  ensureDockerNamedVolume,
  ensureDockerNetwork,
  localDockerId,
  normalizeProjectId,
  resolveDockerNetworkMode,
  resolveEdgeRuntimeVersion,
  resolveFunctionsDockerImage,
  runChildProcess,
  toDockerPath,
} from "./functions-docker.ts";
import { loadFunctionsProjectConfig, type FunctionsGoConfigCompat } from "./functions-config.ts";
import { edgeRuntimeImage, resolveEdgeRuntimeVersionPin } from "./functions.shared.ts";
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
   * `undefined` in `next`; the legacy shell injects
   * `legacyFunctionsGoConfigCompat` so this file never imports `legacy/`
   * directly — see {@link FunctionsGoConfigCompat}. Distinct from
   * `goViperCompat` above, which only gates `env(...)` interpolation.
   */
  readonly goConfigCompat: FunctionsGoConfigCompat | undefined;
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
  /** Go's post-`loadNestedEnv` merged env (ambient-wins). `undefined` in `next`. */
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
  readonly matchPaths?: ReadonlySet<string>;
}

export interface StartedRuntime {
  readonly containerId: string;
  readonly cleanup: Effect.Effect<void>;
  readonly watchSpecs: ReadonlyArray<WatchSpec>;
}

/**
 * Every already-resolved secret/key {@link startEdgeRuntimeContainer} needs,
 * matching {@link finalizeAuthArtifacts}'s return shape. Named and exported so
 * a caller outside this module (`start`'s own edge-runtime bring-up,
 * `legacy/commands/start/services/edge-runtime.service.ts`) can build the
 * exact same shape from values it has already resolved itself, instead of
 * calling {@link resolveLocalAuthArtifacts} (which re-reads `config.toml`/signing
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
 * (`resolveServeConfig`/`resolveLocalAuthArtifacts`) and its file-watch/log-stream
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
  /** Standalone `functions serve` discovers `supabase/functions/<slug>/.env`; `start` does not. */
  readonly discoverFunctionEnvFiles: boolean;
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
            const watcher = watch(root, { recursive: true }, (eventType, filename) => {
              const pathname =
                filename === null || filename === undefined || filename.length === 0
                  ? root
                  : resolve(root, filename.toString());
              // Node's `fs.watch` only distinguishes "rename" (create/delete/
              // rename) from "change" (write); Go prints the real fsnotify op
              // (`internal/functions/serve/watcher.go:100`). The closest
              // recoverable equivalent is an existence check on "rename"
              // events: present → create, gone → delete; "change" → update.
              const type: FileWatchEvent["type"] =
                eventType === "rename" ? (existsSync(pathname) ? "create" : "delete") : "update";
              Queue.offerUnsafe(queue, [{ path: pathname, type }]);
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
 * exact `Redacted`-unwrapping/zero-hash-filtering logic against its own,
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
    // Go's config loader rewrites every `[edge_runtime.secrets]` key with
    // `strings.ToUpper` (`pkg/config/config.go:766-771`, the viper #1014
    // workaround) before `set.ListSecrets`
    // (`internal/secrets/set/set.go:48-52`) reads the map, so secret names
    // always reach the container env UPPERCASED regardless of authored
    // casing. ListSecrets then keeps only entries with a non-empty SHA256:
    // `DecryptSecretHookFunc` (`pkg/config/secret.go:94-107`) leaves the
    // SHA256 empty exactly when the value is empty or a still-unresolved
    // `env(VAR)` literal. In the TS pipeline `resolveProjectSubtree` wraps
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

/**
 * {@link resolveLocalAuthArtifacts}'s return shape — everything
 * {@link finalizeAuthArtifacts} needs to assemble the final
 * {@link ServeAuthArtifacts} once the remote-JWKS fetch is allowed to run
 * (i.e. after the DB assertion — see {@link startEdgeRuntime}).
 */
interface ServeLocalAuthArtifacts {
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly jwtSecret: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  /** Third-party issuer to fetch remote JWKS from, if one is configured. */
  readonly issuerUrl: string | undefined;
  /** Local JWKS entries (signing keys / oct fallback), appended AFTER any remote keys (`config.go:1776-1786`). */
  readonly localKeys: ReadonlyArray<unknown>;
}

/**
 * Config-load-time auth resolution — exactly the work Go performs during
 * `flags.LoadConfig`/`Config.Validate`, BEFORE `AssertSupabaseDbIsRunning`:
 * the signing-keys read (`pkg/config/config.go:1110-1115`), the
 * `auth.jwt_secret` ≥16-chars check (`pkg/config/apikeys.go:43-47` via
 * `config.go:1156`), and anon/service-role key generation. Deliberately does
 * NOT fetch remote JWKS: Go only does that inside `ServeFunctions`
 * (`serve.go:141` → `ResolveJWKS`, `config.go:1727-1776`), after the DB
 * assertion — that half lives in {@link finalizeAuthArtifacts} so a config
 * error here still beats a docker-down error, matching Go's precedence.
 */
const resolveLocalAuthArtifacts = Effect.fnUntraced(function* (
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

  // Go's `Auth.ThirdParty.validate()` (the "at most one enabled" + required-field checks
  // `resolveThirdPartyIssuerUrl` performs) only runs inside `Config.Validate`'s `if
  // c.Auth.Enabled` block (`config.go:1087-1153`), but `functions serve`'s own JWKS resolution
  // (`serve.go:141`) discards `ResolveJWKS`'s error unconditionally, regardless of `auth.enabled`.
  // So a malformed/multi-enabled third-party config must not throw here when auth is disabled —
  // use the unchecked, no-throw `IssuerURL()`-only builder instead, matching Go exactly.
  const issuerUrl = auth.enabled
    ? resolveThirdPartyIssuerUrl(auth.third_party)
    : thirdPartyIssuerUrlUnchecked(auth.third_party);
  const localKeys: unknown[] = [];
  localKeys.push(
    ...(signingKeys.length > 0
      ? signingKeys.map(toPublicJwk)
      : shouldUseJwtSecretFallback
        ? [defaultSigningKey]
        : []),
  );
  if (shouldUseJwtSecretFallback) {
    localKeys.push({
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
    issuerUrl,
    localKeys,
  } satisfies ServeLocalAuthArtifacts;
});

/**
 * The post-assertion half of `functions serve`'s auth resolution — Go's
 * `ResolveJWKS` call inside `ServeFunctions` (`serve.go:141`,
 * `pkg/config/config.go:1727-1786`): fetch the third-party provider's remote
 * JWKS (two sequential OIDC/JWKS requests with 10s-timeout clients,
 * `config.go:1727-1776`) with the fetch error discarded (`jwks, _ :=`), then
 * assemble the final key set with remote keys FIRST and local keys after
 * (`config.go:1776-1786`). Kept separate from
 * {@link resolveLocalAuthArtifacts} so `startEdgeRuntime` can run it strictly
 * after `assertLocalDbRunning`, matching Go's ordering — with Docker down, no
 * external JWKS request is ever made.
 */
const finalizeAuthArtifacts = Effect.fnUntraced(function* (local: ServeLocalAuthArtifacts) {
  const keys: unknown[] = [];
  if (local.issuerUrl !== undefined) {
    const issuerUrl = local.issuerUrl;
    const remoteJwks = yield* Effect.tryPromise({
      try: () => resolveRemoteJwks(issuerUrl),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
    keys.push(...remoteJwks);
  }
  keys.push(...local.localKeys);

  return {
    publishableKey: local.publishableKey,
    secretKey: local.secretKey,
    jwtSecret: local.jwtSecret,
    anonKey: local.anonKey,
    serviceRoleKey: local.serviceRoleKey,
    jwks: JSON.stringify({ keys }),
  } satisfies ServeAuthArtifacts;
});

const resolveServeConfig = Effect.fnUntraced(function* (
  projectRoot: string,
  projectIdOverride: Option.Option<string>,
  goViperCompat: boolean,
  goConfigCompat: FunctionsGoConfigCompat | undefined,
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
  //
  // `search: false`/`tomlOnly: true` when `goConfigCompat` is set (legacy
  // shell): this MUST match `loadFunctionsProjectConfig`'s own options below
  // exactly, or the two loads can resolve two different files (an ancestor's
  // config.toml vs this dir's; a stray config.json vs config.toml) — one
  // supplying `auth`/`edgeRuntime`/`apiPort` here, the other supplying
  // `denoVersion`/`Config.Validate` below, silently mixing fields from two
  // different projects. `next` (`goConfigCompat === undefined`) keeps the
  // package defaults (ancestor search, JSON preferred), unchanged.
  const loadedConfig = yield* loadProjectConfig(projectRoot, {
    ...(projectRef === undefined ? {} : { projectRef }),
    ...(projectEnv === null ? {} : { projectEnv }),
    goViperCompat,
    ...(goConfigCompat === undefined ? {} : { search: false, tomlOnly: true }),
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

  // Go: `flags.LoadConfig` -> `Config.Validate` (`pkg/config/config.go:878,989-1192`)
  // — `restartEdgeRuntime` runs this FIRST, before `AssertSupabaseDbIsRunning`
  // (see this function's own caller for that ordering) — so an invalid
  // config must fail here too, before any Docker check. Legacy shell only;
  // `next` keeps its own package-default config resolution above unchanged.
  // A second, independent config/dotenv load (rather than reusing this
  // function's own `loadedConfig`/`projectEnv` above) — that pipeline's
  // `env(...)`-interpolation purpose is unrelated to Go's `SUPABASE_*`
  // `AutomaticEnv` override system this one provides, and the two shouldn't
  // be entangled for a shipped, long-running command's config path.
  // `search`/`tomlOnly` are aligned with this file's own `loadedConfig` call
  // above (see its comment) so the two loads can never disagree about which
  // file is "the" project config. `projectEnvValues` (for registry/network-id
  // env lookups, this file's own caller) and the env-overridden
  // `deno_version` are consumed from it; `auth`/`apiPort`/functions above
  // keep their existing derivation. `projectId` also keeps its existing
  // derivation — a known gap, narrow to trigger but NOT cosmetic when hit:
  // unlike `deploy`/`download` (which use `context.projectId` outright),
  // `rawProjectId` below only ever sees `SUPABASE_PROJECT_ID` from the
  // *ambient* shell (`projectIdOverride`, from `LegacyCliConfig`), not from
  // project dotenv. A project that sets it only in `supabase/.env` therefore
  // gets a different `supabase_edge_runtime_<id>`/`supabase_network_<id>`
  // here than `deploy`/`download`/`start` resolve for the SAME project — so
  // `serve` creates a second network and a container `reloadKong(projectId)`'s
  // Kong (named off the other id) can't route to: a silently non-functional
  // `serve`, where Go reads one `Config.ProjectId` for everything. Folding
  // `goContext.projectEnvValues` in here would also require reconciling this
  // function's `projectIdOverride`-wins-unconditionally precedence with
  // `legacyResolveLocalProjectId`'s config-file-wins-over-`projectRef`
  // precedence (they're not the same order) — left open rather than risking
  // that regression under time pressure (review round on CLI-1963).
  const goContext =
    goConfigCompat === undefined
      ? undefined
      : yield* loadFunctionsProjectConfig({
          projectRoot,
          projectRef,
          goConfigCompat,
        });

  return {
    projectId: normalizeProjectId(rawProjectId.length > 0 ? rawProjectId : fallbackProjectId),
    apiPort,
    auth,
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
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  envFile: Readonly<Record<string, string>>,
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
    env.map(([_, value], index) =>
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
      const contents = yield* Effect.tryPromise({
        try: () =>
          readFile(envPath, "utf8").then(
            (value) => value,
            (error) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return undefined;
              }
              throw error;
            },
          ),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
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

/**
 * Whether any bind mounts something at `containerPath` or below it, i.e. whether
 * that path exists inside the container. Docker creates a missing `--workdir`,
 * but Podman rejects the container outright (supabase/cli#6035), so the flag can
 * only be set for a path a bind actually materializes.
 */
function hasBindUnder(binds: Iterable<string>, containerPath: string): boolean {
  for (const bind of binds) {
    const target = dockerBindContainerPath(bind);
    if (target === containerPath || target.startsWith(`${containerPath}/`)) {
      return true;
    }
  }
  return false;
}

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

/**
 * fsnotify op tokens as Go prints them in the file-change line
 * (`event.Op.String()`, `internal/functions/serve/watcher.go:100`). RENAME and
 * CHMOD are unreachable here: Node's `fs.watch` folds renames into
 * create/delete pairs and does not report metadata-only changes.
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
      fileWatcher.watch(spec.root, { ignore: watchIgnoreGlobs }).pipe(
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
  // A spawn failure (neither `docker` nor `podman` on PATH) must keep its
  // cause: it is the shell-out equivalent of Go's missing daemon socket, which
  // `client.IsErrConnectionFailed` classifies as a connection failure and so
  // gets the Docker Desktop install hint (`internal/utils/misc.go:155-166`).
  // Blanking stderr here would demote it to a bare "failed to inspect
  // service" with no guidance.
  const result = yield* runChildProcess("docker", ["container", "inspect", dbId], {
    stdout: "ignore",
    stderr: "pipe",
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({ exitCode: 1, stdout: "", stderr: legacyDescribeContainerCliFailure(cause) }),
    ),
  );

  if (result.exitCode === 0) {
    return;
  }

  if (result.stderr.includes("No such container") || result.stderr.includes("No such object")) {
    return yield* Effect.fail(new Error("supabase start is not running."));
  }

  const message =
    result.stderr.trim().length > 0
      ? `failed to inspect service: ${result.stderr.trim()}`
      : "failed to inspect service";
  // Go's `AssertServiceIsRunning` sets `CmdSuggestion = suggestDockerInstall`
  // on a daemon-connection failure (`internal/utils/misc.go:155-166`), which
  // `recoverAndExit` prints on its own stderr line after the red error
  // (`cmd/root.go:300-303`) — mirrored here by the `suggestion` property that
  // `normalizeCliError`/`Output.fail` render the same way.
  return yield* Effect.fail(
    legacyIsDockerDaemonUnreachable(result.stderr)
      ? Object.assign(new Error(message), { suggestion: LEGACY_SUGGEST_DOCKER_INSTALL })
      : new Error(message),
  );
});

const bestEffortRemoveContainer = Effect.fnUntraced(function* (containerId: string) {
  yield* runChildProcess("docker", ["container", "rm", "-f", "-v", containerId], {
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(Effect.ignore);
});

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

const reloadKong = Effect.fnUntraced(function* (projectId: string) {
  const output = yield* Output;
  const kongId = localDockerId("kong", projectId);
  // Reload re-renders nginx.conf from Kong's default template, so it needs the
  // template bring-up wrote (`kong.service.ts`; formerly Go's
  // `start.go:589-592`, deleted as unreachable in CLI-1966, last present at
  // commit a253ccba2) handed back — otherwise it drops that template's
  // `email_templates` server (#6059). Go's own `restartEdgeRuntime`
  // (`internal/functions/serve/serve.go:129`) passes the same flag for the
  // same reason — an earlier revision of this file dropped it believing it was
  // start-only (#5976), which #6065 proved wrong.
  const result = yield* runChildProcess(
    "docker",
    ["exec", kongId, "kong", "reload", "--nginx-conf", "/home/kong/custom_nginx.template"],
    { stdout: "ignore", stderr: "pipe" },
  ).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));

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
 * (formerly `internal/start/start.go:1149-1159`, deleted as unreachable in
 * CLI-1966; last present at commit a253ccba2), which needs only the bind mounts,
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
 * bring-up (formerly `internal/start/start.go:1101-1108`, no wrapper step in
 * between; `internal/start` was deleted as unreachable in CLI-1966, last
 * present at commit a253ccba2).
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
      const functionEnv =
        input.discoverFunctionEnvFiles && Option.isNone(input.envFile)
          ? yield* parseFunctionEnvFile(join(functionsDir, config.slug, ".env"))
          : {};
      functionsConfig[config.slug] = toFunctionContainerConfig(
        input.projectRoot,
        config,
        functionEnv,
      );
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
      // Streamed in via `docker cp` between create and start: embedding the template in the
      // `sh -c` argv hits Windows ENAMETOOLONG (#5711), and a single-file host bind mounts as
      // an empty directory on daemons that cannot see this host's filesystem (#6254, #4190).
      const serveMainArchive = yield* Effect.tryPromise({
        try: () => containerArchiveBytes({ [serveMainContainerPath]: serveMainTemplate }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      const containerProjectRoot = toDockerPath(input.projectRoot);
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
        "nofile=65536:65536",
        "--label",
        `com.supabase.cli.project=${labels["com.supabase.cli.project"]}`,
        "--label",
        `com.docker.compose.project=${labels["com.docker.compose.project"]}`,
        "--label",
        `${dockerWorkdirLabel}=${input.projectRoot}`,
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

      // The container must exist for `docker cp` to have a target, and must not be running
      // yet so edge-runtime never races the copy.
      yield* runEdgeRuntimeDockerStep(command);
      yield* runEdgeRuntimeDockerStep(["cp", "-", `${containerId}:/`], {
        messagePrefix: "failed to copy edge runtime main service into container",
        stdin: Stream.make(serveMainArchive),
      });
      yield* runEdgeRuntimeDockerStep(["start", containerId]);

      return {
        containerId,
        cleanup: removeRuntimeArtifacts.pipe(Effect.orDie),
        watchSpecs: yield* Effect.promise(() => buildWatchSpecs([...functionBinds])),
      } satisfies StartedRuntime;
    }).pipe(Effect.onError(() => bestEffortCleanupRuntimeArtifacts));
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
  const output = yield* Output;
  // Deliberately NO docker precheck here — Go's `restartEdgeRuntime`
  // (`internal/functions/serve/serve.go:107-113`) runs its sanity checks in
  // order: `flags.LoadConfig` first, then `utils.AssertSupabaseDbIsRunning()`.
  // A down Docker daemon therefore surfaces from the DB inspect below
  // (`assertLocalDbRunning`) as `failed to inspect service: …` with the
  // Docker Desktop install hint as a suggestion (`misc.go:155-166`), never as
  // an upfront `failed to run docker.` failure. The remote-JWKS fetch is
  // likewise held until AFTER that assertion (`finalizeAuthArtifacts` below —
  // Go only fetches inside `ServeFunctions`, `serve.go:141`), so a down
  // daemon never waits on external OIDC/JWKS requests first.
  const resolved = yield* resolveServeConfig(
    input.dependencies.projectRoot,
    input.dependencies.projectIdOverride,
    input.dependencies.goViperCompat,
    input.dependencies.goConfigCompat,
  );
  const projectId = resolved.projectId;
  const containerId = localDockerId("edge_runtime", projectId);
  let ownsRuntime = false;
  let startedRuntime: StartedRuntime | undefined;
  return yield* Effect.gen(function* () {
    // `SUPABASE_NETWORK_ID` (env or project dotenv) is legacy-shell-only —
    // same Go-viper-parity gate as `resolved.projectEnvValues` itself
    // (`undefined` in `next`).
    const networkMode = resolveDockerNetworkMode({
      explicit: Option.getOrUndefined(input.networkId),
      envOverride:
        resolved.projectEnvValues === undefined
          ? undefined
          : legacyViperEnvStringWithProjectFallback(
              "SUPABASE_NETWORK_ID",
              resolved.projectEnvValues,
            ),
      projectId,
    });
    const localAuthArtifacts = yield* resolveLocalAuthArtifacts(resolved.auth, resolved.configPath);
    const edgeRuntimeVersionOverride = yield* resolveEdgeRuntimeVersionPin(
      input.dependencies.supabaseDir,
    );
    const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersion(
      resolved.edgeRuntime.deno_version,
      edgeRuntimeVersionOverride,
    );

    yield* assertLocalDbRunning(projectId);
    yield* bestEffortRemoveContainer(containerId);
    ownsRuntime = true;

    // Go's `restartEdgeRuntime` prints this right before calling `ServeFunctions`
    // (`serve.go:124-125`) — `ServeFunctions` itself (this file's `startEdgeRuntimeContainer`,
    // also called directly by `start.go:1104`) never prints it, so it belongs in this
    // `functions serve`-only wrapper, not the shared core.
    yield* output.raw("Setting up Edge Functions runtime...\n", "stderr");

    // Go's remote-JWKS fetch happens inside `ServeFunctions` (`serve.go:141`)
    // — i.e. after `AssertSupabaseDbIsRunning`, the container removal, and the
    // "Setting up…" print above — never before. Finalizing here (rather than
    // inside `startEdgeRuntimeContainer`) keeps the shared core's
    // caller-supplies-artifacts contract intact for `start`'s bring-up
    // (`edge-runtime.service.ts`), which resolves its own JWKS.
    const authArtifacts = yield* finalizeAuthArtifacts(localAuthArtifacts);

    // Go: `DockerStart` -> `DockerResolveImageIfNotCached` (`internal/utils/docker.go:326-386`)
    // — resolved here, not earlier: `hasLocalImage` fails fast on an
    // unreachable daemon, which would otherwise hijack the down-daemon
    // message `assertLocalDbRunning` above is responsible for producing.
    //
    // Known ordering divergence (not fixed here — see below): Go's own
    // `ServeFunctions` (`serve.go:134-167`) parses `--env-file` and every
    // per-function config BEFORE ever calling `DockerStart`
    // (`serve.go:218`), so a broken env file or function config fails fast,
    // before any pull. This port's `startEdgeRuntimeContainer` (below) does
    // that same parsing internally, but AFTER receiving an already-resolved
    // `image` — so on a cold image cache, a broken `--env-file` now surfaces
    // after a potentially slow `docker pull` instead of immediately. Fixing
    // this properly means splitting `startEdgeRuntimeContainer` into a
    // "build container config" phase and a "run it" phase so this resolve
    // can move between them — but that function is also `start`'s bring-up
    // core (`edge-runtime.service.ts`), which already passes in a
    // pre-resolved image via `legacyEnsureImagesCached`, so restructuring it
    // risks that shipped, more critical path. Left as a documented
    // UX-only regression (the command still fails with the right error,
    // just later) rather than a hasty change to shared, `start`-critical
    // code (review round on CLI-1963).
    const image = yield* resolveFunctionsDockerImage(
      edgeRuntimeImage(edgeRuntimeVersion),
      resolved.projectEnvValues,
    );

    startedRuntime = yield* startEdgeRuntimeContainer({
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
      discoverFunctionEnvFiles: true,
      importMap: input.flags.importMap,
      noVerifyJwt: input.flags.noVerifyJwt,
      inspectMode: input.inspectMode,
      inspectMain: input.flags.inspectMain,
    });

    yield* reloadKong(projectId);

    return startedRuntime;
  }).pipe(
    // `startEdgeRuntimeContainer`'s own `Effect.onError` only reaches while it's still running —
    // once it returns successfully, an interrupt here (e.g. mid-`reloadKong`) escapes that scope
    // entirely, so this wrapper must also run the returned runtime's own staging-file cleanup,
    // not just remove the container.
    Effect.onInterrupt(() =>
      Effect.all([
        ownsRuntime ? bestEffortRemoveContainer(containerId) : Effect.void,
        startedRuntime === undefined ? Effect.void : startedRuntime.cleanup,
      ]).pipe(Effect.asVoid),
    ),
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
