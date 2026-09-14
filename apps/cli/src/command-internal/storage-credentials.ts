import { Effect, FileSystem, Path } from "effect";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { resolveApiExternalUrl } from "./api-url.ts";
import { validateApiPort, validateApiTlsPresence } from "./config-validate.ts";
import { loadProjectEnv } from "./db-config.toml-read.ts";
import { mapTenantApiKeysError } from "./get-tenant-api-keys.ts";
import { generateGoJwt } from "./go-jwt.ts";
import { getHostname } from "./hostname.ts";
import {
  decryptAuthSecret,
  envOverride,
  envOverrideBool,
  envOverridePort,
  resolveJwtSecret,
} from "./local-config-values.ts";
import { KONG_LOCAL_CA_CERT } from "./kong-local-ca-cert.ts";
import { extractServiceKeys } from "./tenant-keys.ts";
import {
  StorageApiKeysNetworkError,
  StorageAuthTokenError,
  StorageConfigError,
  StorageMissingApiKeyError,
} from "./storage-credentials.errors.ts";

/**
 * Resolves Storage gateway credentials (base URL, service-role key, and local
 * CA) for `seed buckets` and `storage ls/cp/mv/rm`.
 *
 * Local (`projectRef === ""`): URL from `api.external_url` or
 * `<scheme>://<host>:<api.port>`, and key from
 * `auth.service_role_key`/`auth.jwt_secret`, both after
 * `SUPABASE_API_*`/`SUPABASE_AUTH_*` overrides (see
 * {@link resolveLocalApiConfig} and {@link resolveLocalServiceRoleKey}).
 * Remote: URL is `https://<ref>.<projectHost>`; key from
 * `SUPABASE_AUTH_SERVICE_ROLE_KEY` or the project's api-keys endpoint.
 */

/** Structural subset of `@supabase/config`'s CliConfig used here. */
export interface StorageConfigView {
  readonly api: {
    readonly enabled: boolean;
    readonly external_url?: string;
    readonly port: number;
    readonly tls: {
      readonly enabled: boolean;
      readonly cert_path?: string;
      readonly key_path?: string;
    };
  };
  readonly auth: {
    readonly jwt_secret?: string;
    readonly service_role_key?: string;
  };
}

interface StorageCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The CA PEM to trust for a local https gateway; `undefined` otherwise. */
  readonly localKongCa: string | undefined;
}

export const resolveStorageCredentials = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
  readonly config: StorageConfigView;
  /**
   * Already-resolved project env map for the `SUPABASE_API_*`/`SUPABASE_AUTH_*`
   * overrides, when the caller has one in scope. When omitted, this loads the
   * project dotenv itself.
   */
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}) {
  const cliSettings = yield* CommandSettings;

  if (opts.projectRef !== "") {
    const baseUrl = `https://${opts.projectRef}.${cliSettings.projectHost}`;
    const envKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    if (envKey !== undefined && envKey.length > 0) {
      return { baseUrl, apiKey: envKey, localKongCa: undefined } satisfies StorageCredentials;
    }
    // Resolved lazily so the local path never triggers auth.
    const api = yield* (yield* CommandPlatformApiFactory).make;
    const keys = extractServiceKeys(
      yield* api.v1.getProjectApiKeys({ ref: opts.projectRef, reveal: true }).pipe(
        Effect.catch(
          mapTenantApiKeysError({
            networkError: StorageApiKeysNetworkError,
            statusError: StorageAuthTokenError,
          }),
        ),
      ),
    );
    if (keys.anon === "" && keys.serviceRole === "") {
      return yield* new StorageMissingApiKeyError({ message: "Anon key not found." });
    }
    return {
      baseUrl,
      apiKey: keys.serviceRole,
      localKongCa: undefined,
    } satisfies StorageCredentials;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectEnvValues =
    opts.projectEnvValues ??
    (yield* loadProjectEnv(fs, path, cliSettings.workdir).pipe(
      Effect.mapError((cause) => new StorageConfigError({ message: cause.message })),
    ));
  const api = yield* resolveLocalApiConfig(opts.config.api, projectEnvValues);
  const baseUrl = resolveApiExternalUrl(api, getHostname());
  const apiKey = yield* resolveLocalServiceRoleKey(opts.config.auth, projectEnvValues);

  // Validate the cert/key pairing only when the API and TLS are both enabled;
  // inject a CA whenever the resolved URL is https.
  let localKongCa: string | undefined;
  const validatedCa =
    api.enabled && api.tls.enabled
      ? yield* validateLocalKongTls(
          fs,
          path,
          cliSettings.workdir,
          api.tls.cert_path,
          api.tls.key_path,
        )
      : undefined;
  if (baseUrl.startsWith("https:")) {
    localKongCa = validatedCa ?? KONG_LOCAL_CA_CERT;
  }
  return { baseUrl, apiKey, localKongCa } satisfies StorageCredentials;
});

/**
 * Converts a thrown config-load validation error (from `envOverride*`,
 * `decryptAuthSecret`, `resolveJwtSecret`, `validateApi*`) into a tagged
 * `StorageConfigError`, preserving the original message.
 */
const toStorageConfigError = (cause: unknown) =>
  new StorageConfigError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

/**
 * Folds `SUPABASE_API_*` overrides into `[api]` before deriving the gateway
 * URL, so a stack started with an overridden port stays reachable here
 * instead of falling back to the raw `config.toml` value.
 */
const resolveLocalApiConfig = (
  api: StorageConfigView["api"],
  projectEnvValues: Readonly<Record<string, string>>,
) =>
  Effect.try({
    try: () => {
      const resolved = {
        enabled: envOverrideBool(
          "SUPABASE_API_ENABLED",
          api.enabled,
          "api.enabled",
          projectEnvValues,
        ),
        external_url: envOverride("SUPABASE_API_EXTERNAL_URL", api.external_url, projectEnvValues),
        port: envOverridePort("SUPABASE_API_PORT", api.port, "api.port", projectEnvValues),
        tls: {
          enabled: envOverrideBool(
            "SUPABASE_API_TLS_ENABLED",
            api.tls.enabled,
            "api.tls.enabled",
            projectEnvValues,
          ),
          cert_path: envOverride("SUPABASE_API_TLS_CERT_PATH", api.tls.cert_path, projectEnvValues),
          key_path: envOverride("SUPABASE_API_TLS_KEY_PATH", api.tls.key_path, projectEnvValues),
        },
      } satisfies StorageConfigView["api"];
      validateApiPort(resolved.enabled, resolved.port);
      return resolved;
    },
    catch: toStorageConfigError,
  });

/**
 * Resolves the service-role key for the local Storage gateway:
 * - jwt secret: `SUPABASE_AUTH_JWT_SECRET` → `auth.jwt_secret` →
 *   `defaultJwtSecret`, rejected if shorter than 16 chars.
 * - service-role key: `SUPABASE_AUTH_SERVICE_ROLE_KEY` →
 *   `auth.service_role_key` → signed from the resolved jwt secret.
 *
 * An explicit `service_role_key = ""` is treated as unset and regenerated.
 */
const resolveLocalServiceRoleKey = Effect.fnUntraced(function* (
  auth: StorageConfigView["auth"],
  projectEnvValues: Readonly<Record<string, string>>,
) {
  const jwtSecret = yield* Effect.try({
    try: () =>
      resolveJwtSecret(
        decryptAuthSecret(
          envOverride("SUPABASE_AUTH_JWT_SECRET", auth.jwt_secret, projectEnvValues),
          projectEnvValues,
        ),
      ),
    catch: toStorageConfigError,
  });
  const configuredKey = yield* Effect.try({
    try: () =>
      decryptAuthSecret(
        envOverride("SUPABASE_AUTH_SERVICE_ROLE_KEY", auth.service_role_key, projectEnvValues),
        projectEnvValues,
      ),
    catch: toStorageConfigError,
  });
  return configuredKey !== undefined && configuredKey.length > 0
    ? configuredKey
    : generateGoJwt(jwtSecret, "service_role");
});

/**
 * Runs the local config-load validations (API overrides, auth secret
 * decryption, TLS presence) without building credentials, for `seed
 * buckets`'s empty-config short-circuit.
 */
export const validateLocalStorageConfig = Effect.fnUntraced(function* (
  config: StorageConfigView,
  projectEnvValues: Readonly<Record<string, string>>,
) {
  const api = yield* resolveLocalApiConfig(config.api, projectEnvValues);
  yield* resolveLocalServiceRoleKey(config.auth, projectEnvValues);
  if (api.enabled && api.tls.enabled) {
    yield* Effect.try({
      try: () => validateApiTlsPresence(api.tls.cert_path, api.tls.key_path),
      catch: toStorageConfigError,
    });
  }
});

/**
 * Validates the local Kong TLS cert/key pairing: cert without key (or vice
 * versa) errors; both present and readable returns the cert PEM; neither
 * returns the embedded CA. Only called when the API and TLS are both enabled.
 */
const validateLocalKongTls = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  certPath: string | undefined,
  keyPath: string | undefined,
) {
  // Presence validation lives in `config-validate.ts`; this only does the file I/O.
  yield* Effect.try({
    try: () => validateApiTlsPresence(certPath, keyPath),
    catch: toStorageConfigError,
  });

  if (certPath !== undefined && certPath.length > 0) {
    // Cert/key paths join unconditionally with the supabase dir, even if they look absolute.
    const absCert = path.join(workdir, "supabase", certPath);
    const certContent = yield* fs.readFileString(absCert).pipe(
      Effect.catchTag(
        "PlatformError",
        (cause) =>
          new StorageConfigError({
            message: `failed to read TLS cert: ${String(cause.cause ?? cause)}`,
          }),
      ),
    );
    const absKey = path.join(workdir, "supabase", keyPath!);
    yield* fs.readFileString(absKey).pipe(
      Effect.catchTag(
        "PlatformError",
        (cause) =>
          new StorageConfigError({
            message: `failed to read TLS key: ${String(cause.cause ?? cause)}`,
          }),
      ),
    );
    return certContent;
  }

  return KONG_LOCAL_CA_CERT;
});

/**
 * Returns a fetch that injects `tls.ca` into every request, trusting the
 * given CA PEM for HTTPS connections to the local Kong gateway. Bun's fetch
 * accepts `{ tls: { ca } }` via `BunFetchRequestInit`, which extends
 * `RequestInit`, so no `as` cast is needed.
 */
function kongCaFetch(ca: string): typeof globalThis.fetch {
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const caInit: BunFetchRequestInit = { ...init, tls: { ca } };
    return globalThis.fetch(input, caInit);
  };
  return Object.assign(fetchImpl, { preconnect: globalThis.fetch.preconnect });
}

/**
 * `FetchHttpClient.Fetch` override for Storage gateway calls: a CA-trusting
 * fetch for a local https gateway, plain `globalThis.fetch` otherwise. Storage
 * calls never use DNS-over-HTTPS, so this always replaces the shared
 * DoH-wrapped client at the gateway scope.
 */
export function storageGatewayFetch(localKongCa: string | undefined): typeof globalThis.fetch {
  return localKongCa !== undefined ? kongCaFetch(localKongCa) : globalThis.fetch;
}
