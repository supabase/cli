import { Effect, FileSystem, Option, Path, Result } from "effect";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { pickCliEnvName } from "../config/cli-config-key.ts";
import { CliEnvNames } from "../config/cli-config-keys.ts";
import { readShellEnvironment } from "../shared/config/cli-config-env.ts";
import { resolveApiExternalUrl } from "./api-url.ts";
import { validateApiPort, validateApiTlsPresence } from "./config-validate.ts";
import { describeConfigLoadFailure, loadResolvedConfigContext } from "./resolved-config-context.ts";
import { mapTenantApiKeysError } from "./get-tenant-api-keys.ts";
import { generateLocalJwt } from "./local-jwt.ts";
import { getHostname } from "./hostname.ts";
import { resolveJwtSecret } from "./local-config-values.ts";
import { KONG_LOCAL_CA_CERT } from "./kong-local-ca-cert.ts";
import { extractServiceKeys } from "./tenant-keys.ts";
import {
  StorageApiKeysNetworkError,
  StorageAuthTokenError,
  StorageConfigError,
  StorageMissingApiKeyError,
} from "./storage-credentials.errors.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { stackStorageEndpoint } from "./stack-storage.ts";

/**
 * Resolves Storage gateway credentials (base URL, service-role key, and local
 * CA) for `seed buckets` and `storage ls/cp/mv/rm`.
 *
 * Linked (`projectRef !== ""`): URL is `https://<ref>.<projectHost>`; key from
 * `SUPABASE_AUTH_SERVICE_ROLE_KEY` or the project's api-keys endpoint.
 * Stack backend (`experimental.stack`): endpoint and service-role JWT come from the managed
 * stack (see {@link stackStorageEndpoint}); never a legacy fallback.
 * Legacy local: URL from `api.external_url` or `<scheme>://<host>:<api.port>`, and key from
 * `auth.service_role_key`/`auth.jwt_secret`, both after `SUPABASE_API_*`/`SUPABASE_AUTH_*`
 * overrides (see {@link resolveLocalApiConfig} and {@link resolveLocalServiceRoleKey}).
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

export interface StorageCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The CA PEM to trust for a local https gateway; `undefined` otherwise. */
  readonly localKongCa: string | undefined;
}

export const resolveStorageCredentials = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
}) {
  const cliSettings = yield* CommandSettings;

  if (opts.projectRef !== "") {
    const baseUrl = `https://${opts.projectRef}.${cliSettings.projectHost}`;
    const shell = yield* readShellEnvironment({
      names: [CliEnvNames.authServiceRoleKey.name],
    }).pipe(Effect.mapError(toStorageConfigError));
    const envKey = yield* Result.match(
      pickCliEnvName(CliEnvNames.authServiceRoleKey, { shell: shell.get }),
      {
        onFailure: (error) => Effect.fail(toStorageConfigError(error)),
        onSuccess: Effect.succeed,
      },
    );
    if (Option.isSome(envKey)) {
      return {
        baseUrl,
        apiKey: envKey.value,
        localKongCa: undefined,
      } satisfies StorageCredentials;
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

  // Stack backend: endpoint and JWT come from the stack; no `[api]`/SUPABASE_API_*/jwt_secret/
  // Kong CA, and no legacy fallback.
  const backend = yield* currentStackBackend;
  if (backend.kind === "stack") return yield* stackStorageEndpoint;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { config, projectEnvValues } = yield* loadLocalStorageConfig(cliSettings.workdir);
  const api = yield* resolveLocalApiConfig(config.api);
  const baseUrl = resolveApiExternalUrl(
    api,
    yield* getHostname(projectEnvValues).pipe(
      Effect.mapError((cause) => new StorageConfigError({ message: cause.message })),
    ),
  );
  const apiKey = yield* resolveLocalServiceRoleKey(config.auth);

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
 * Converts a thrown config-load validation error (from `resolveJwtSecret`, `validateApi*`) into a tagged
 * `StorageConfigError`, preserving the original message.
 */
const toStorageConfigError = (cause: unknown) =>
  new StorageConfigError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

const loadLocalStorageConfig = (workdir: string) =>
  loadResolvedConfigContext(workdir).pipe(
    Effect.mapError(
      (cause) => new StorageConfigError({ message: describeConfigLoadFailure(cause) }),
    ),
  );

/** The effective `[api]` view, with the port and TLS pairing checked, for deriving the gateway URL. */
const resolveLocalApiConfig = (api: StorageConfigView["api"]) =>
  Effect.try({
    try: () => {
      validateApiPort(api.enabled, api.port);
      return api;
    },
    catch: toStorageConfigError,
  });

/**
 * Resolves the service-role key for the local Storage gateway:
 * - jwt secret: `auth.jwt_secret` → `defaultJwtSecret`, rejected if shorter than 16 chars.
 * - service-role key: `auth.service_role_key` → signed from the resolved jwt secret.
 *
 * An explicit `service_role_key = ""` is treated as unset and regenerated.
 */
const resolveLocalServiceRoleKey = Effect.fnUntraced(function* (auth: StorageConfigView["auth"]) {
  const jwtSecret = yield* Effect.try({
    try: () => resolveJwtSecret(auth.jwt_secret),
    catch: toStorageConfigError,
  });
  const configuredKey = auth.service_role_key;
  return configuredKey !== undefined && configuredKey.length > 0
    ? configuredKey
    : generateLocalJwt(jwtSecret, "service_role");
});

/**
 * Runs the local config-load validations (API port, auth secrets, TLS presence) without building
 * credentials, for `seed buckets`'s empty-config short-circuit.
 */
export const validateLocalStorageConfig = Effect.fnUntraced(function* () {
  const cliSettings = yield* CommandSettings;
  const { config } = yield* loadLocalStorageConfig(cliSettings.workdir);
  const api = yield* resolveLocalApiConfig(config.api);
  yield* resolveLocalServiceRoleKey(config.auth);
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
