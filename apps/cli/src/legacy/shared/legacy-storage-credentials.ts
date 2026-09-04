import { defaultJwtSecret, generateJwt } from "@supabase/stack/effect";
import { Effect, FileSystem, Path } from "effect";

import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { LegacyCliSettings } from "../config/legacy-cli-settings.service.ts";
import { legacyResolveApiExternalUrl } from "./legacy-api-url.ts";
import { legacyValidateApiPort, legacyValidateApiTlsPresence } from "./legacy-config-validate.ts";
import { legacyLoadProjectEnv } from "./legacy-db-config.toml-read.ts";
import { legacyMapTenantApiKeysError } from "./legacy-get-tenant-api-keys.ts";
import { legacyGetHostname } from "./legacy-hostname.ts";
import {
  legacyEnvOverride,
  legacyEnvOverrideBool,
  legacyEnvOverridePort,
} from "./legacy-local-config-values.ts";
import { KONG_LOCAL_CA_CERT } from "./kong-local-ca-cert.ts";
import { legacyExtractServiceKeys } from "./legacy-tenant-keys.ts";
import {
  LegacyStorageApiKeysNetworkError,
  LegacyStorageAuthTokenError,
  LegacyStorageConfigError,
  LegacyStorageMissingApiKeyError,
} from "./legacy-storage-credentials.errors.ts";

/**
 * Resolves the Storage gateway base URL + service-role key (+ local Kong CA),
 * mirroring `client.NewStorageAPI`.
 * Shared by `seed buckets` and `storage ls/cp/mv/rm`.
 *
 * - `projectRef === ""` (local): base URL from `api.external_url` (else
 * `<scheme>://<host>:<api.port>`), with the `SUPABASE_API_*` env/dotenv
 * overrides folded in first (see {@link resolveLocalApiConfig}), service-role
 * key derived from `auth.{service_role_key,jwt_secret}`, and the Kong CA when
 * the URL is https.
 * - remote: base URL `https://<ref>.<projectHost>`; key from
 * `SUPABASE_AUTH_SERVICE_ROLE_KEY` else `tenant.GetApiKeys`.
 *
 * Requires `LegacyCliSettings` (workdir, projectHost) and — only on the remote
 * branch — `LegacyPlatformApiFactory` (lazy, so the local path never touches the
 * Management API).
 */

/** Structural subset of `@supabase/config`'s CliConfig used here. */
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
  /**
   * Already-resolved project env map for the `SUPABASE_API_*` fold, when the
   * caller has one in scope (`legacySeedBucketsRun`, `start`) — same
   * passthrough idea as `legacySeedBucketsRun`'s own `resolvedConfig`. Either
   * walk's shape works — a map that omits ambient-shadowed keys
   * (`legacyLoadProjectEnv`) or one that overlays ambient values
   * (`legacyResolveProjectEnvironmentValues`) — since the override helpers'
   * `map[name] ?? process.env[name]` lookup resolves both identically. When
   * omitted (the `storage` commands), the local branch loads the nested
   * project dotenv walk itself.
   */
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}) {
  const cliSettings = yield* LegacyCliSettings;

  if (opts.projectRef !== "") {
    const baseUrl = `https://${opts.projectRef}.${cliSettings.projectHost}`;
    // Go: `viper.IsSet("AUTH_SERVICE_ROLE_KEY")` → use the env-provided key and
    // skip the tenant lookup.
    const envKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    if (envKey !== undefined && envKey.length > 0) {
      return { baseUrl, apiKey: envKey, localKongCa: undefined } satisfies LegacyStorageCredentials;
    }
    // Resolve the Management API client lazily so the local path never triggers
    // auth (`tenant.GetApiKeys`).
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
    // `tenant.GetApiKeys` fails with `errMissingKey` ("Anon key not found.")
    // when the response yields nothing.
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
  const projectEnvValues =
    opts.projectEnvValues ??
    (yield* legacyLoadProjectEnv(fs, path, cliSettings.workdir).pipe(
      Effect.mapError((cause) => new LegacyStorageConfigError({ message: cause.message })),
    ));
  const api = yield* resolveLocalApiConfig(opts.config.api, projectEnvValues);
  const baseUrl = legacyResolveApiExternalUrl(api, legacyGetHostname());
  const apiKey = yield* resolveLocalServiceRoleKey(opts.config.auth);

  // `status.NewKongClient` installs unconditionally for the local client; its
  // embedded CA only matters for https. `(*api).Validate` resolves cert_path /
  // key_path and validates the pairing only when `api.enabled && api.tls.enabled`.
  // Inject a CA whenever the resolved URL is https
  // (the scheme derives from `api.tls.enabled` alone).
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
  return { baseUrl, apiKey, localKongCa } satisfies LegacyStorageCredentials;
});

/**
 * Fold the `SUPABASE_API_*` env/dotenv overrides into the `[api]` fields the
 * local gateway derives its base URL and TLS material from. Every other local
 * consumer of these fields already reads them post-override
 * (`legacy-local-config-values.ts`'s resolvers, `start.handler.ts`'s
 * `effectiveLocalStorageConfig`); without this fold, a stack brought up with
 * e.g. `SUPABASE_API_PORT=54331` is unreachable here because the gateway URL
 * falls back to the raw `config.toml` port (#6452). `projectEnvValues` is the
 * nested project dotenv map (caller-supplied or loaded by
 * `legacyResolveStorageCredentials`), so a value set only in
 * `supabase/.env`(.local) counts; a caller that already folded these overrides
 * (`start`) re-resolves the same map to the same values, so the fold is
 * idempotent. A malformed port/bool override or an enabled API whose resolved
 * port is `0` (`legacyValidateApiPort` — the canonical branch) is an
 * invalid-config hard failure, same as the sibling resolvers.
 * `[remotes.*]` never merges on the local path (`loadCliConfig` receives no
 * `projectRef` here), so the remote-over-env precedence those resolvers apply
 * does not arise.
 */
const resolveLocalApiConfig = (
  api: LegacyStorageConfigView["api"],
  projectEnvValues: Readonly<Record<string, string>>,
) =>
  Effect.try({
    try: () => {
      const resolved = {
        enabled: legacyEnvOverrideBool(
          "SUPABASE_API_ENABLED",
          api.enabled,
          "api.enabled",
          projectEnvValues,
        ),
        external_url: legacyEnvOverride(
          "SUPABASE_API_EXTERNAL_URL",
          api.external_url,
          projectEnvValues,
        ),
        port: legacyEnvOverridePort("SUPABASE_API_PORT", api.port, "api.port", projectEnvValues),
        tls: {
          enabled: legacyEnvOverrideBool(
            "SUPABASE_API_TLS_ENABLED",
            api.tls.enabled,
            "api.tls.enabled",
            projectEnvValues,
          ),
          cert_path: legacyEnvOverride(
            "SUPABASE_API_TLS_CERT_PATH",
            api.tls.cert_path,
            projectEnvValues,
          ),
          key_path: legacyEnvOverride(
            "SUPABASE_API_TLS_KEY_PATH",
            api.tls.key_path,
            projectEnvValues,
          ),
        },
      } satisfies LegacyStorageConfigView["api"];
      legacyValidateApiPort(resolved.enabled, resolved.port);
      return resolved;
    },
    // A malformed port/bool override or the canonical zero-port rejection
    // collapses into the tagged storage config error, preserving the helper's
    // message — the same collapse every other consumer of these throwing
    // helpers applies (`wrapDbConfigOverride` → `LegacyDbConfigLoadError`),
    // keeping this Effect error channel tagged.
    catch: (cause) =>
      new LegacyStorageConfigError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/**
 * Resolve the service-role key for the local Storage gateway, mirroring Go's
 * `(*auth).generateAPIKeys` + the Viper
 * `AutomaticEnv`/`SUPABASE_` prefix precedence:
 * - jwt secret: `SUPABASE_AUTH_JWT_SECRET` → `auth.jwt_secret` → `defaultJwtSecret`;
 * a resolved secret shorter than 16 chars is rejected;
 * - service-role key: `SUPABASE_AUTH_SERVICE_ROLE_KEY` → `auth.service_role_key`
 * → sign from the resolved secret.
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
 * Validate + resolve the local Kong TLS config, mirroring `(*api).Validate`:
 * cert without key (or vice-versa) errors; both
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
  // The canonical presence rule lives in `legacy-config-validate.ts`; only the
  // file reads below are this caller's own I/O.
  yield* Effect.try({
    try: () => legacyValidateApiTlsPresence(certPath, keyPath),
    catch: (cause) =>
      new LegacyStorageConfigError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  if (certPath !== undefined && certPath.length > 0) {
    // TLS paths join unconditionally with the supabase dir — NO IsAbs guard
    // (`path.Join` absorbs a leading "/").
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
 * Mirrors `newLocalClient`.
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
