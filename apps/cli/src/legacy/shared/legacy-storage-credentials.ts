import { KONG_LOCAL_CA_CERT } from "@supabase/config";
import { defaultJwtSecret, generateJwt } from "@supabase/stack/effect";
import { Effect, FileSystem, Path } from "effect";

import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyResolveApiExternalUrl } from "./legacy-api-url.ts";
import { legacyMapTenantApiKeysError } from "./legacy-get-tenant-api-keys.ts";
import { legacyGetHostname } from "./legacy-hostname.ts";
import { legacyExtractServiceKeys } from "./legacy-tenant-keys.ts";
import {
  LegacyStorageApiKeysNetworkError,
  LegacyStorageAuthTokenError,
  LegacyStorageConfigError,
  LegacyStorageMissingApiKeyError,
} from "./legacy-storage-credentials.errors.ts";

/**
 * Resolves the Storage gateway base URL + service-role key (+ local Kong CA),
 * mirroring Go's `client.NewStorageAPI` (`internal/storage/client/api.go:15-46`).
 * Shared by `seed buckets` and `storage ls/cp/mv/rm`.
 *
 *  - `projectRef === ""` (local): base URL from `api.external_url` (else
 *    `<scheme>://<host>:<api.port>`), service-role key derived from
 *    `auth.{service_role_key,jwt_secret}`, and the Kong CA when the URL is https.
 *  - remote: base URL `https://<ref>.<projectHost>`; key from
 *    `SUPABASE_AUTH_SERVICE_ROLE_KEY` else `tenant.GetApiKeys`.
 *
 * Requires `LegacyCliConfig` (workdir, projectHost) and — only on the remote
 * branch — `LegacyPlatformApiFactory` (lazy, so the local path never touches the
 * Management API).
 */

/** Structural subset of `@supabase/config`'s ProjectConfig used here. */
export interface LegacyStorageConfigView {
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

interface LegacyStorageCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The CA PEM to trust for a local https gateway; `undefined` otherwise. */
  readonly localKongCa: string | undefined;
}

export const legacyResolveStorageCredentials = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
  readonly config: LegacyStorageConfigView;
}) {
  const cliConfig = yield* LegacyCliConfig;

  if (opts.projectRef !== "") {
    const baseUrl = `https://${opts.projectRef}.${cliConfig.projectHost}`;
    // Go: `viper.IsSet("AUTH_SERVICE_ROLE_KEY")` → use the env-provided key and
    // skip the tenant lookup (`api.go:19-21`).
    const envKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    if (envKey !== undefined && envKey.length > 0) {
      return { baseUrl, apiKey: envKey, localKongCa: undefined } satisfies LegacyStorageCredentials;
    }
    // Resolve the Management API client lazily so the local path never triggers
    // auth (`api.go:22` → `tenant.GetApiKeys`).
    const api = yield* (yield* LegacyPlatformApiFactory).make;
    const keys = legacyExtractServiceKeys(
      yield* api.v1.getProjectApiKeys({ ref: opts.projectRef, reveal: true }).pipe(
        Effect.catch(
          legacyMapTenantApiKeysError({
            networkError: LegacyStorageApiKeysNetworkError,
            statusError: LegacyStorageAuthTokenError,
          }),
        ),
      ),
    );
    // Go's `tenant.GetApiKeys` fails with `errMissingKey` ("Anon key not found.")
    // when the response yields nothing (`client.go:24-26,80-82`).
    if (keys.anon === "" && keys.serviceRole === "") {
      return yield* new LegacyStorageMissingApiKeyError({ message: "Anon key not found." });
    }
    return {
      baseUrl,
      apiKey: keys.serviceRole,
      localKongCa: undefined,
    } satisfies LegacyStorageCredentials;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseUrl = resolveLocalBaseUrl(opts.config);
  const apiKey = yield* resolveLocalServiceRoleKey(opts.config.auth);

  // Go installs `status.NewKongClient` unconditionally for the local client; its
  // embedded CA only matters for https. `(*api).Validate` resolves cert_path /
  // key_path and validates the pairing only when `api.enabled && api.tls.enabled`
  // (`config.go:795,841-861`). Inject a CA whenever the resolved URL is https
  // (Go derives the scheme from `api.tls.enabled` alone, `config.go:639-642`).
  let localKongCa: string | undefined;
  const validatedCa =
    opts.config.api.enabled && opts.config.api.tls.enabled
      ? yield* validateLocalKongTls(
          fs,
          path,
          cliConfig.workdir,
          opts.config.api.tls.cert_path,
          opts.config.api.tls.key_path,
        )
      : undefined;
  if (baseUrl.startsWith("https:")) {
    localKongCa = validatedCa ?? KONG_LOCAL_CA_CERT;
  }
  return { baseUrl, apiKey, localKongCa } satisfies LegacyStorageCredentials;
});

/**
 * Local API URL: `legacyResolveApiExternalUrl` with `legacyGetHostname` (Go's
 * `utils.GetHostname`) supplying the host when `api.external_url` is unset.
 */
function resolveLocalBaseUrl(config: LegacyStorageConfigView): string {
  return legacyResolveApiExternalUrl(config.api, legacyGetHostname());
}

/**
 * Resolve the service-role key for the local Storage gateway, mirroring Go's
 * `(*auth).generateAPIKeys` (`pkg/config/apikeys.go:43-63`) + the Viper
 * `AutomaticEnv`/`SUPABASE_` prefix precedence (`config.go:492-497`):
 *  - jwt secret: `SUPABASE_AUTH_JWT_SECRET` → `auth.jwt_secret` → `defaultJwtSecret`;
 *    a resolved secret shorter than 16 chars is rejected;
 *  - service-role key: `SUPABASE_AUTH_SERVICE_ROLE_KEY` → `auth.service_role_key`
 *    → sign from the resolved secret.
 *
 * Empty checks use length, so an explicit `service_role_key = ""` is regenerated
 * like Go (not sent as the empty string).
 */
const resolveLocalServiceRoleKey = Effect.fnUntraced(function* (auth: {
  readonly jwt_secret?: string;
  readonly service_role_key?: string;
}) {
  const envSecret = process.env["SUPABASE_AUTH_JWT_SECRET"];
  const configuredSecret =
    envSecret !== undefined && envSecret.length > 0 ? envSecret : auth.jwt_secret;

  let jwtSecret: string;
  if (configuredSecret === undefined || configuredSecret.length === 0) {
    jwtSecret = defaultJwtSecret;
  } else if (configuredSecret.length < 16) {
    return yield* new LegacyStorageConfigError({
      message: "Invalid config for auth.jwt_secret. Must be at least 16 characters",
    });
  } else {
    jwtSecret = configuredSecret;
  }

  const envKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
  const configuredKey = envKey !== undefined && envKey.length > 0 ? envKey : auth.service_role_key;
  return configuredKey !== undefined && configuredKey.length > 0
    ? configuredKey
    : generateJwt(jwtSecret, "service_role");
});

/**
 * Validate + resolve the local Kong TLS config, mirroring Go's `(*api).Validate`
 * (`pkg/config/config.go:845-861`): cert without key (or vice-versa) errors; both
 * present and readable returns the cert PEM; neither returns the embedded CA.
 *
 * Only called when `api.enabled && api.tls.enabled` (Go gates both path
 * resolution and validation on `c.Api.Enabled`). The CLI uses only the CA cert,
 * but Go reads the key to validate the pairing, so this mirrors that.
 */
const validateLocalKongTls = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  certPath: string | undefined,
  keyPath: string | undefined,
) {
  const hasCert = certPath !== undefined && certPath.length > 0;
  const hasKey = keyPath !== undefined && keyPath.length > 0;

  if (hasCert && !hasKey) {
    return yield* new LegacyStorageConfigError({
      message: "Missing required field in config: api.tls.key_path",
    });
  }
  if (hasKey && !hasCert) {
    return yield* new LegacyStorageConfigError({
      message: "Missing required field in config: api.tls.cert_path",
    });
  }

  if (hasCert) {
    // Go joins TLS paths unconditionally with the supabase dir — NO IsAbs guard
    // (config.go:795-801 uses path.Join, which absorbs a leading "/").
    const absCert = path.join(workdir, "supabase", certPath);
    const certContent = yield* fs.readFileString(absCert).pipe(
      Effect.catchTag(
        "PlatformError",
        (cause) =>
          new LegacyStorageConfigError({
            message: `failed to read TLS cert: ${String(cause.cause ?? cause)}`,
          }),
      ),
    );
    const absKey = path.join(workdir, "supabase", keyPath!);
    yield* fs.readFileString(absKey).pipe(
      Effect.catchTag(
        "PlatformError",
        (cause) =>
          new LegacyStorageConfigError({
            message: `failed to read TLS key: ${String(cause.cause ?? cause)}`,
          }),
      ),
    );
    return certContent;
  }

  return KONG_LOCAL_CA_CERT;
});

/**
 * Builds a `typeof globalThis.fetch` that injects `tls.ca` into every request,
 * trusting the provided CA PEM for HTTPS connections to the local Kong gateway.
 * Mirrors Go's `newLocalClient` (`internal/storage/client/api.go:30-37`).
 *
 * Bun's fetch accepts `{ tls: { ca: string } }` via `BunFetchRequestInit`, which
 * extends `RequestInit`; no `as` cast is needed.
 */
function legacyKongCaFetch(ca: string): typeof globalThis.fetch {
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
 * The `FetchHttpClient.Fetch` override to provide for Storage gateway calls: a
 * CA-trusting fetch for a local https gateway, plain `globalThis.fetch`
 * otherwise. Storage calls never use DoH in Go (`newLocalClient` /
 * `newRemoteClient` use `status.NewKongClient` / `http.DefaultClient`), so the
 * DoH-wrapped shared client is always overridden at the gateway scope.
 */
export function legacyStorageGatewayFetch(
  localKongCa: string | undefined,
): typeof globalThis.fetch {
  return localKongCa !== undefined ? legacyKongCaFetch(localKongCa) : globalThis.fetch;
}
