import {
  KONG_LOCAL_CA_CERT,
  loadProjectConfig,
  type LoadProjectConfigOptions,
  ProjectConfigSchema,
} from "@supabase/config";
import { defaultJwtSecret, generateJwt } from "@supabase/stack/effect";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { PlatformError } from "effect/PlatformError";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { legacyMapTenantApiKeysError } from "../../../shared/legacy-get-tenant-api-keys.ts";
import { legacyExtractServiceKeys } from "../../../shared/legacy-tenant-keys.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacySeedChangedTargetFlags } from "./buckets.flags.ts";
import { legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyGetHostname } from "../../../shared/legacy-hostname.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  legacyIsLocalVectorBucketsUnavailable,
  legacyIsVectorBucketsFeatureNotEnabled,
} from "./buckets.classify.ts";
import {
  type LegacyStorageGateway,
  type LegacyUpsertBucketProps,
  legacyMakeStorageGateway,
} from "./buckets.gateway.ts";
import {
  LegacySeedApiKeysNetworkError,
  LegacySeedAuthTokenError,
  LegacySeedConfigLoadError,
  LegacySeedMissingApiKeyError,
  LegacySeedStorageNetworkError,
  LegacySeedStorageStatusError,
} from "./buckets.errors.ts";
import {
  legacyBucketObjectKey,
  legacyContentTypeForUpload,
  legacyParseFileSizeLimit,
} from "./buckets.upload.ts";
import type { LegacyBucketsFlags } from "./buckets.command.ts";

const CONFIG_PATH = "supabase/config.toml";
const UPLOAD_CONCURRENCY = 5;

/**
 * Builds a `typeof globalThis.fetch` that injects `tls.ca` into every request,
 * trusting the provided CA PEM for HTTPS connections to the local Kong gateway.
 *
 * Mirrors Go's `newLocalClient` (`apps/cli-go/internal/storage/client/api.go:30-37`),
 * which appends `utils.Config.Api.Tls.CertContent` to the TLS cert pool.
 *
 * Bun's fetch accepts `{ tls: { ca: string } }` in the same position as
 * `BunFetchRequestInit.tls`; the `ca` field is Bun-specific and is typed via
 * `BunFetchRequestInit` (a Bun global). No `as` cast is needed: the init object
 * is typed as `BunFetchRequestInit` which extends the standard `RequestInit`.
 */
function legacyKongCaFetch(ca: string): typeof globalThis.fetch {
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const caInit: BunFetchRequestInit = { ...init, tls: { ca } };
    return globalThis.fetch(input, caInit);
  };
  // Attach `preconnect` so the override is structurally complete as
  // `typeof globalThis.fetch` — mirrors the same pattern in legacy-http-dns.ts.
  return Object.assign(fetchImpl, { preconnect: globalThis.fetch.preconnect });
}

/**
 * Validates and resolves the local Kong TLS configuration, mirroring Go's
 * `(*api).Validate` (`apps/cli-go/pkg/config/config.go:845-861`) which runs at
 * config-load before `NewStorageAPI`:
 *  1. `cert_path` set, `key_path` empty → error
 *  2. `cert_path` set, unreadable → error
 *  3. `key_path` set, `cert_path` empty → error
 *  4. `key_path` set, unreadable → error
 *  5. Both set and readable → returns the CA PEM (cert content)
 *  6. Neither set → returns the embedded `KONG_LOCAL_CA_CERT`
 *
 * The CLI only uses the CA cert for trusting the Kong gateway, but Go also reads
 * the key purely to validate the pairing, so we mirror that behaviour.
 *
 * // TODO: broader `@supabase/config` gap — `packages/config/src/api.ts` models
 * // `tls.cert_path` / `tls.key_path` but has no pairing or readability validation.
 * // Once @supabase/config adds `(*api).Validate`, this helper can be removed and
 * // the error mapping moved to the `ProjectConfigParseError` catch above.
 *
 * Only called when `projectRef === ""` (local) AND `config.api.enabled` AND
 * `config.api.tls.enabled` — Go gates both path resolution (`config.go:795`)
 * and validation (`config.go:841`) on `c.Api.Enabled`.
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
    return yield* new LegacySeedConfigLoadError({
      message: "Missing required field in config: api.tls.key_path",
    });
  }
  if (hasKey && !hasCert) {
    return yield* new LegacySeedConfigLoadError({
      message: "Missing required field in config: api.tls.cert_path",
    });
  }

  if (hasCert) {
    // Go joins TLS paths unconditionally with the supabase dir — NO IsAbs guard
    // (config.go:795-801 uses path.Join, which absorbs a leading "/" on the
    // joined element), so `cert_path = "/tmp/kong.crt"` resolves under
    // supabase/tmp/kong.crt. This differs from objects_path below, which Go
    // guards with !filepath.IsAbs (config.go:753-761).
    const absCert = path.join(workdir, "supabase", certPath);
    const certContent = yield* fs.readFileString(absCert).pipe(
      Effect.catchTag(
        "PlatformError",
        (cause) =>
          new LegacySeedConfigLoadError({
            message: `failed to read TLS cert: ${String(cause.cause ?? cause)}`,
          }),
      ),
    );
    // keyPath is non-empty here because hasKey === true (cert+key both present);
    // joined unconditionally, same as cert_path above (config.go:795-801).
    const absKey = path.join(workdir, "supabase", keyPath!);
    yield* fs.readFileString(absKey).pipe(
      Effect.catchTag(
        "PlatformError",
        (cause) =>
          new LegacySeedConfigLoadError({
            message: `failed to read TLS key: ${String(cause.cause ?? cause)}`,
          }),
      ),
    );
    return certContent;
  }

  return KONG_LOCAL_CA_CERT;
});

/**
 * Mirrors Go's `ValidateBucketName` regex (`apps/cli-go/pkg/config/config.go:1382`).
 * Used to validate `[storage.buckets]` names before any Storage API call, matching
 * Go's config-load-time check (`config.go:899-903`). Vector and analytics names are
 * NOT validated here — Go only validates `[storage.buckets]`.
 */
const LEGACY_BUCKET_NAME_PATTERN = /^(?:[0-9A-Za-z_]|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

/**
 * Verbatim Go regex literal (`config.go:1382`) — used in the error message so it
 * is byte-identical to Go's output. Do NOT derive from `LEGACY_BUCKET_NAME_PATTERN.source`.
 */
const LEGACY_BUCKET_NAME_PATTERN_SOURCE =
  "^(\\w|!|-|\\.|\\*|'|\\(|\\)| |&|\\$|@|=|;|:|\\+|,|\\?)*$";

const legacyValidateBucketName = Effect.fnUntraced(function* (name: string) {
  if (!LEGACY_BUCKET_NAME_PATTERN.test(name)) {
    return yield* new LegacySeedConfigLoadError({
      message: `Invalid Bucket name: ${name}. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed. (${LEGACY_BUCKET_NAME_PATTERN_SOURCE})`,
    });
  }
});

type StorageError = LegacySeedStorageNetworkError | LegacySeedStorageStatusError;

interface CollectedFile {
  readonly absPath: string;
  readonly displayPath: string;
}

/** Mutable run summary, emitted as the structured result in json/stream-json mode. */
interface SeedSummary {
  readonly buckets_created: Array<string>;
  readonly buckets_updated: Array<string>;
  readonly buckets_skipped: Array<string>;
  readonly vector_created: Array<string>;
  readonly vector_pruned: Array<string>;
  vector_skipped: boolean;
  readonly objects_uploaded: Array<string>;
  readonly analytics_created: Array<string>;
  readonly analytics_pruned: Array<string>;
}

function emptySummary(): SeedSummary {
  return {
    buckets_created: [],
    buckets_updated: [],
    buckets_skipped: [],
    vector_created: [],
    vector_pruned: [],
    vector_skipped: false,
    objects_uploaded: [],
    analytics_created: [],
    analytics_pruned: [],
  };
}

/**
 * Embedded-default project config, decoded from an empty object — the same
 * `decodeUnknownSync(ProjectConfigSchema)({})` the loader uses internally
 * (`packages/config/src/io.ts:54-56`). Go's `seed buckets` never aborts on a
 * missing `config.toml`: it reads the package-global `utils.Config`, which is
 * initialized to embedded defaults (`internal/utils/config.go:100`), and
 * `config.Load` no-ops on a missing file (`mergeFileConfig` → nil). So "no
 * config file" behaves like the embedded-default config.
 */
const legacyDecodeDefaultProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

/**
 * `supabase seed buckets` — seeds Storage buckets from
 * `[storage.buckets]` / `[storage.vector]` in `supabase/config.toml`.
 *
 * Port of `apps/cli-go/internal/seed/buckets/buckets.go`. When `--linked` is
 * passed, the remote Storage gateway is used with the project's service-role key;
 * otherwise the local stack is used.
 */
export const legacySeedBuckets = Effect.fn("legacy.seed.buckets")(function* (
  // Target is selected from the changed-flag set (Go's flag.Changed), not the
  // parsed value, so the flags arg itself is unused here.
  _flags: LegacyBucketsFlags,
) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliArgs = yield* CliArgs;
  const yes = yield* LegacyYesFlag;

  // Set once --linked resolves a ref; drives the post-run linked-project cache
  // write + org/project group identify, mirroring Go's `ensureProjectGroupsCached`
  // (`cmd/root.go`, gated on a non-empty `flags.ProjectRef`). Empty on the local
  // path, so the cache is never written there.
  let linkedRef = "";

  yield* Effect.gen(function* () {
    // 1. Resolve the project ref for --linked BEFORE loading config, so that
    // the matching `[remotes.<name>]` override (whose `project_id == ref`) is
    // merged over the base config by `loadProjectConfig`. Mirrors Go's
    // `Config.ProjectId = ProjectRef` → `config.Load` sequence
    // (`apps/cli-go/pkg/config/config.go:505-518`).
    // Go selects the target from `flag.Changed`, not the flag value
    // (`internal/utils/flags/db_url.go:46-63`): `--linked` is the linked path
    // whenever it's *set*, even `--linked=false`. Use the changed-flag set
    // (the `--local`/`--linked` mutual-exclusivity is enforced before
    // instrumentation in `buckets.command.ts`), not `flags.linked`'s value.
    const setFlags = legacySeedChangedTargetFlags(cliArgs.args);
    const projectRefResolver = yield* LegacyProjectRefResolver;
    const projectRef = setFlags.includes("linked")
      ? yield* projectRefResolver.loadProjectRef(Option.none())
      : "";
    linkedRef = projectRef;

    // 2. Load config.toml, passing projectRef so `[remotes.*]` overrides are
    // merged for --linked. A parse failure aborts before any network call.
    const loadOptions: LoadProjectConfigOptions | undefined =
      projectRef !== "" ? { projectRef } : undefined;
    const loaded = yield* loadProjectConfig(cliConfig.workdir, loadOptions).pipe(
      Effect.catchTag(
        "ProjectConfigParseError",
        (cause) =>
          new LegacySeedConfigLoadError({
            message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
          }),
      ),
    );
    // A missing config file is NOT an early exit: Go uses embedded defaults and
    // still gates the no-op on `len(projectRef) == 0` (`internal/seed/buckets/
    // buckets.go:16-20`). So local + no-config falls into the no-op short-circuit
    // below (emitting the empty summary in json/stream-json); `--linked` +
    // no-config falls through to the remote path so auth/project/API failures
    // surface, exactly as the Go command does.
    const config = loaded === null ? legacyDecodeDefaultProjectConfig({}) : loaded.config;
    const document = loaded === null ? undefined : loaded.document;

    // Go prints this from inside config load (`config.go:513`,
    // `fmt.Fprintln(os.Stderr, "Loading config override:", idToName[projectId])`),
    // unconditionally and before any command output, whenever a `[remotes.*]`
    // block's project_id matched the linked ref. `appliedRemote` is the bare name,
    // bracketed here to match Go's `idToName` value (`config.go:511`). Same emit as
    // `config push` (push.handler.ts). stderr in all output modes (diagnostic-only).
    if (loaded !== null && loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }
    const bucketsConfig = config.storage.buckets ?? {};
    const bucketNames = Object.keys(bucketsConfig);
    const vectorEnabled = config.storage.vector.enabled;
    const vectorBucketNames = Object.keys(config.storage.vector.buckets);
    const hasVectorBuckets = vectorBucketNames.length > 0;

    // 3. Config-load-time validations run BEFORE the no-op short-circuit: Go
    // decodes the whole config (storage.FileSizeLimit, bucket sizes) and runs
    // ValidateBucketName during config.Load — before `buckets.Run` can take its
    // no-op path — so an invalid value fails even when there's nothing to seed.
    //
    // 3a. Bucket names (Go ValidateBucketName, config.go:899-903).
    for (const name of bucketNames) {
      yield* legacyValidateBucketName(name);
    }

    // 3b. Storage-level file_size_limit, parsed unconditionally (Go unmarshals
    // `storage.FileSizeLimit` at config.Load regardless of buckets).
    const storageFileSizeLimitBytes = yield* parseFileSizeLimitOrFail(
      config.storage.file_size_limit,
    );

    // 3c. Per-bucket props (sizes parsed before any Storage call).
    const bucketPropsByName = new Map<string, LegacyUpsertBucketProps>();
    for (const [name, bucket] of Object.entries(bucketsConfig)) {
      bucketPropsByName.set(
        name,
        yield* computeBucketProps(document, name, bucket, storageFileSizeLimitBytes),
      );
    }

    // 3d. Short-circuit: nothing to seed (ref present → never short-circuits).
    if (projectRef === "" && bucketNames.length === 0 && !hasVectorBuckets) {
      // Go emits nothing in text mode; in the additive json/stream-json modes a
      // scripted caller still expects a result object, so emit an empty summary.
      if (output.format !== "text") {
        yield* output.success("", { ...emptySummary() });
      }
      return;
    }

    // 4. Build the Storage service-gateway client (local or remote).
    let baseUrl: string;
    let apiKey: string;

    if (projectRef === "") {
      baseUrl = resolveLocalBaseUrl(config);
      apiKey = yield* resolveLocalServiceRoleKey(config.auth);
    } else {
      baseUrl = `https://${projectRef}.${cliConfig.projectHost}`;
      const envKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
      if (envKey !== undefined && envKey.length > 0) {
        apiKey = envKey;
      } else {
        // Go builds the remote Storage client via `tenant.GetApiKeys`
        // (`internal/storage/client/api.go:22`), which maps a non-200 to
        // `Authorization failed for the access token and project ref pair: <body>`
        // (`internal/utils/tenant/client.go:15,77-78`) — NOT the `projects api-keys`
        // helper's `unexpected get api keys status ...`. Resolve the client lazily
        // so the local path never triggers Management API auth.
        const api = yield* (yield* LegacyPlatformApiFactory).make;
        const keys = legacyExtractServiceKeys(
          yield* api.v1.getProjectApiKeys({ ref: projectRef, reveal: true }).pipe(
            Effect.catch(
              legacyMapTenantApiKeysError({
                networkError: LegacySeedApiKeysNetworkError,
                statusError: LegacySeedAuthTokenError,
              }),
            ),
          ),
        );
        // Go's tenant.GetApiKeys fails with errMissingKey ("Anon key not found.")
        // when the api-keys response yields nothing, before building the remote
        // Storage client (`internal/utils/tenant/client.go:24-26,80-82`).
        if (keys.anon === "" && keys.serviceRole === "") {
          return yield* new LegacySeedMissingApiKeyError({ message: "Anon key not found." });
        }
        apiKey = keys.serviceRole;
      }
    }

    // Kong CA trust for the LOCAL path. Go's `newLocalClient` installs
    // `status.NewKongClient` unconditionally (`internal/storage/client/api.go:30-37`)
    // — its embedded CA only matters for https — and `(*api).Validate` resolves
    // `cert_path`/`key_path` (`config.go:795`) and validates the cert/key pairing
    // (`config.go:841-861`) only when `api.enabled && api.tls.enabled` (both
    // blocks are gated on `c.Api.Enabled`). So: validate (and resolve a cert_path
    // CA) only when the api is enabled AND tls is enabled; inject the CA whenever
    // the resolved local URL is https — Go derives the scheme from `api.tls.enabled`
    // alone (`config.go:639-642`, NOT gated on `api.enabled`), so an `enabled=false`
    // + `tls.enabled=true` config still yields an https URL and the embedded CA —
    // and never for the remote `--linked` host.
    let localKongCa: string | undefined;
    if (projectRef === "") {
      const validatedCa =
        config.api.enabled && config.api.tls.enabled
          ? yield* validateLocalKongTls(
              fs,
              path,
              cliConfig.workdir,
              config.api.tls.cert_path,
              config.api.tls.key_path,
            )
          : undefined;
      if (baseUrl.startsWith("https:")) {
        localKongCa = validatedCa ?? KONG_LOCAL_CA_CERT;
      }
    }

    // All gateway operations run with an explicit non-DoH fetch. Storage calls
    // never use DoH in Go: `newLocalClient` uses `status.NewKongClient` and
    // `newRemoteClient` uses `http.DefaultClient` — `withFallbackDNS` is installed
    // only in `utils.GetSupabase` (Management API, `internal/utils/api.go:125-127`).
    // `legacyHttpClientLayer` bakes the DoH wrapper into the shared client, so we
    // override `FetchHttpClient.Fetch` at this scope UNCONDITIONALLY: a CA-trusting
    // fetch for local + https, plain `globalThis.fetch` otherwise. (`Fetch` is read
    // per request from the fiber context, so the scope override applies to every
    // gateway call.) The api-keys lookup above runs through the platform API factory
    // BEFORE this scope, so it still honors `--dns-resolver https`, matching Go's
    // `tenant.GetApiKeys` → `GetSupabase`.
    const gatewayOps = Effect.gen(function* () {
      const gateway = yield* legacyMakeStorageGateway({
        baseUrl,
        apiKey,
        userAgent: cliConfig.userAgent,
      });

      const summary = emptySummary();

      // 5. Upsert configured buckets.
      yield* upsertBuckets(output, yes, gateway, bucketPropsByName, summary);

      // 6. Upsert analytics buckets (remote --linked only).
      if (config.storage.analytics.enabled && projectRef !== "") {
        yield* output.raw("Updating analytics buckets...\n", "stderr");
        yield* upsertAnalyticsBuckets(
          output,
          yes,
          gateway,
          Object.keys(config.storage.analytics.buckets),
          summary,
        );
      }

      // 7. Upsert vector buckets (local), with graceful skip on unavailability.
      if (vectorEnabled && hasVectorBuckets) {
        yield* output.raw("Updating vector buckets...\n", "stderr");
        yield* upsertVectorBuckets(output, yes, gateway, vectorBucketNames, summary).pipe(
          Effect.catch((error) => handleVectorError(output, error, summary)),
        );
      }

      // 8. Upload objects for each bucket with a configured objects_path.
      yield* uploadObjects(fs, path, output, gateway, cliConfig.workdir, bucketsConfig, summary);

      // 9. Machine-readable summary (Go has none; text mode emits nothing extra).
      if (output.format !== "text") {
        yield* output.success("", { ...summary });
      }
    });

    // Non-DoH fetch for every gateway call: CA-trusting for local + https, plain
    // `globalThis.fetch` otherwise. Never the DoH-wrapped shared client.
    yield* gatewayOps.pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        localKongCa !== undefined ? legacyKongCaFetch(localKongCa) : globalThis.fetch,
      ),
    );
  }).pipe(
    // Go's root `Execute` caches the linked project + fires org/project group
    // identify whenever `flags.ProjectRef` is set — only on the --linked path.
    // `suspend` defers reading `linkedRef` until the finalizer runs (after the
    // ref has been resolved inside the gen).
    Effect.ensuring(
      Effect.suspend(() => (linkedRef === "" ? Effect.void : linkedProjectCache.cache(linkedRef))),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});

/**
 * Local API URL, mirroring Go's `config.go:634-644` + `misc.go:298`: an explicit
 * `api.external_url` wins, otherwise `<scheme>://<host>:<port>` where the scheme
 * follows `api.tls.enabled`, the host is resolved by `legacyGetHostname` (Go's
 * `utils.GetHostname`: `SUPABASE_SERVICES_HOSTNAME` → TCP Docker daemon host →
 * `127.0.0.1`), and the port is `api.port`.
 */
function resolveLocalBaseUrl(config: {
  readonly api: {
    readonly external_url?: string;
    readonly port: number;
    readonly tls: { readonly enabled: boolean };
  };
}): string {
  if (config.api.external_url !== undefined && config.api.external_url.length > 0) {
    return config.api.external_url;
  }
  const host = legacyGetHostname();
  const scheme = config.api.tls.enabled ? "https" : "http";
  // Go builds the host:port with net.JoinHostPort (config.go:636-638), which
  // brackets an IPv6 host (e.g. `::1` → `[::1]:54321`); a bare `::1:54321` is an
  // invalid URL. legacyGetHostname returns the unbracketed host, so bracket here.
  const hostPort = host.includes(":")
    ? `[${host}]:${config.api.port}`
    : `${host}:${config.api.port}`;
  return `${scheme}://${hostPort}`;
}

/**
 * Resolve the service-role key used against the local Storage gateway, mirroring
 * Go's `(*auth).generateAPIKeys` (`apps/cli-go/pkg/config/apikeys.go:43-63`),
 * which `config.Load` always runs before `NewStorageAPI`. Applies env-var
 * precedence matching Go's Viper `AutomaticEnv`+`SUPABASE_` prefix
 * (`apps/cli-go/pkg/config/config.go:492-497`):
 *  - jwt secret: `SUPABASE_AUTH_JWT_SECRET` env (if set & non-empty) →
 *    `auth.jwt_secret` (if non-empty) → `defaultJwtSecret`;
 *  - a resolved secret shorter than 16 chars is rejected;
 *  - service-role key: `SUPABASE_AUTH_SERVICE_ROLE_KEY` env (if set & non-empty) →
 *    `auth.service_role_key` (if non-empty) → sign from resolved secret.
 *
 * `@supabase/config` has no `generateAPIKeys` equivalent (the keys are
 * `optionalKey` with no default), so this fill-in is the caller's job. Empty
 * checks use length, not nullishness, so an explicit `service_role_key = ""` is
 * regenerated like Go (`??` would have sent the empty string). An unresolved
 * `env(...)` literal is passed through verbatim, exactly as Go does
 * (`pkg/config/decode_hooks.go:15-26` leaves it, and a non-empty literal is not
 * regenerated by `generateAPIKeys`).
 */
const resolveLocalServiceRoleKey = Effect.fnUntraced(function* (auth: {
  readonly jwt_secret?: string;
  readonly service_role_key?: string;
}) {
  // Apply env-var precedence for jwt_secret (Go Viper AutomaticEnv).
  const envSecret = process.env["SUPABASE_AUTH_JWT_SECRET"];
  const configuredSecret =
    envSecret !== undefined && envSecret.length > 0 ? envSecret : auth.jwt_secret;

  let jwtSecret: string;
  if (configuredSecret === undefined || configuredSecret.length === 0) {
    jwtSecret = defaultJwtSecret;
  } else if (configuredSecret.length < 16) {
    return yield* new LegacySeedConfigLoadError({
      message: "Invalid config for auth.jwt_secret. Must be at least 16 characters",
    });
  } else {
    jwtSecret = configuredSecret;
  }

  // Apply env-var precedence for service_role_key (Go Viper AutomaticEnv).
  const envKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
  const configuredKey = envKey !== undefined && envKey.length > 0 ? envKey : auth.service_role_key;
  return configuredKey !== undefined && configuredKey.length > 0
    ? configuredKey
    : generateJwt(jwtSecret, "service_role");
});

type BucketsConfig = Readonly<
  Record<
    string,
    {
      readonly public: boolean;
      readonly file_size_limit: string;
      readonly allowed_mime_types: ReadonlyArray<string>;
      readonly objects_path: string;
    }
  >
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the bucket's TOML entry explicitly declares a `public` key. Go reads
 * `public` into a `*bool`, so an absent key serialises as omitted (not `false`).
 * The decoded `@supabase/config` value defaults to `false` and loses this, so we
 * recover presence from the raw (post-`env()`) document.
 */
function bucketHasPublicKey(document: Record<string, unknown> | undefined, name: string): boolean {
  return bucketHasKey(document, name, "public");
}

/**
 * Whether the bucket's TOML entry explicitly declares `file_size_limit`. Absent
 * decodes to the bucket schema default (`50MiB`), losing the "omitted" signal Go
 * relies on to inherit the storage-level limit, so recover presence from the raw
 * (post-`env()`) document — same approach as `bucketHasPublicKey`.
 */
function bucketHasFileSizeLimit(
  document: Record<string, unknown> | undefined,
  name: string,
): boolean {
  return bucketHasKey(document, name, "file_size_limit");
}

function bucketHasKey(
  document: Record<string, unknown> | undefined,
  name: string,
  key: string,
): boolean {
  if (document === undefined) return false;
  const storage = document["storage"];
  if (!isRecord(storage)) return false;
  const buckets = storage["buckets"];
  if (!isRecord(buckets)) return false;
  const bucket = buckets[name];
  return isRecord(bucket) && key in bucket;
}

/**
 * Resolve a bucket's create/update props, mirroring Go's `config.resolve()`
 * (`apps/cli-go/pkg/config/config.go:753-756`) + the `sizeInBytes` decode that
 * happens at config-load **before** `NewStorageAPI`:
 *  - an omitted or zero `file_size_limit` inherits the storage-level limit;
 *  - the size is parsed up front, so an invalid value fails (mapped to a
 *    config-load error) before any Storage list/create/update side effect — Go
 *    rejects the same config during `LoadConfig`.
 */
// Parse a `file_size_limit` string to bytes, mapping a parse failure to a
// config-load error (Go rejects an invalid `sizeInBytes` during `config.Load`,
// before NewStorageAPI).
const parseFileSizeLimitOrFail = (value: string) =>
  Effect.try({
    try: () => legacyParseFileSizeLimit(value),
    catch: (cause) =>
      new LegacySeedConfigLoadError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const computeBucketProps = Effect.fnUntraced(function* (
  document: Record<string, unknown> | undefined,
  name: string,
  bucket: BucketsConfig[string],
  storageFileSizeLimitBytes: number,
) {
  // Go's resolve() inherits the (already-parsed) storage-level limit when the
  // bucket omits its own / sets 0 (`config.go:753-756`).
  const bucketBytes = bucketHasFileSizeLimit(document, name)
    ? yield* parseFileSizeLimitOrFail(bucket.file_size_limit)
    : 0;
  const fileSizeLimit = bucketBytes === 0 ? storageFileSizeLimitBytes : bucketBytes;

  return {
    public: bucketHasPublicKey(document, name) ? bucket.public : undefined,
    fileSizeLimit,
    allowedMimeTypes: bucket.allowed_mime_types,
  } satisfies LegacyUpsertBucketProps;
});

/**
 * Confirm-or-default prompt mirroring Go's `console.PromptYesNo`
 * (`internal/utils/console.go`): `--yes`/`SUPABASE_YES` echoes `<label> [Y/n] y`
 * and returns true even on a TTY; a real TTY in text mode otherwise prompts;
 * everything else (non-interactive, json/stream-json) uses the default silently.
 */
const promptYesNo = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  label: string,
  defaultValue: boolean,
) {
  if (yes) {
    const choices = defaultValue ? "Y/n" : "y/N";
    yield* output.raw(`${label} [${choices}] y\n`, "stderr");
    return true;
  }
  if (output.format !== "text") {
    return defaultValue;
  }
  return yield* output
    .promptConfirm(label, { defaultValue })
    .pipe(Effect.catchTag("NonInteractiveError", () => Effect.succeed(defaultValue)));
});

// Port of `pkg/storage/batch.go:UpsertBuckets`. `propsByName` is precomputed and
// size-validated before this runs (Go parses sizes at config-load, before any
// Storage call).
const upsertBuckets = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  gateway: LegacyStorageGateway,
  propsByName: ReadonlyMap<string, LegacyUpsertBucketProps>,
  summary: SeedSummary,
) {
  const existing = yield* gateway.listBuckets();
  const byName = new Map(existing.map((b) => [b.name, b.id]));

  for (const [name, props] of propsByName) {
    const bucketId = byName.get(name);
    if (bucketId !== undefined) {
      const overwrite = yield* promptYesNo(
        output,
        yes,
        `Bucket ${legacyBold(bucketId)} already exists. Do you want to overwrite its properties?`,
        true,
      );
      if (!overwrite) {
        summary.buckets_skipped.push(bucketId);
        continue;
      }
      yield* output.raw(`Updating Storage bucket: ${bucketId}\n`, "stderr");
      yield* gateway.updateBucket(bucketId, props);
      summary.buckets_updated.push(bucketId);
    } else {
      yield* output.raw(`Creating Storage bucket: ${name}\n`, "stderr");
      yield* gateway.createBucket(name, props);
      summary.buckets_created.push(name);
    }
  }
});

// Port of `pkg/storage/vector.go:UpsertVectorBuckets`.
const upsertVectorBuckets = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  gateway: LegacyStorageGateway,
  configuredNames: ReadonlyArray<string>,
  summary: SeedSummary,
) {
  const existing = yield* gateway.listVectorBuckets();
  const existingSet = new Set(existing);
  const configuredSet = new Set(configuredNames);
  const toDelete = existing.filter((name) => !configuredSet.has(name));

  for (const name of configuredNames) {
    if (existingSet.has(name)) {
      yield* output.raw(`Bucket already exists: ${name}\n`, "stderr");
      continue;
    }
    yield* output.raw(`Creating vector bucket: ${name}\n`, "stderr");
    yield* gateway.createVectorBucket(name);
    summary.vector_created.push(name);
  }

  for (const name of toDelete) {
    const prune = yield* promptYesNo(
      output,
      yes,
      `Bucket ${legacyBold(name)} not found in ${legacyBold(CONFIG_PATH)}. Do you want to prune it?`,
      false,
    );
    if (!prune) {
      continue;
    }
    yield* output.raw(`Pruning vector bucket: ${name}\n`, "stderr");
    yield* gateway.deleteVectorBucket(name);
    summary.vector_pruned.push(name);
  }
});

// Port of `pkg/storage/analytics.go:UpsertAnalyticsBuckets`.
const upsertAnalyticsBuckets = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  gateway: LegacyStorageGateway,
  configuredNames: ReadonlyArray<string>,
  summary: SeedSummary,
) {
  const existing = yield* gateway.listAnalyticsBuckets();
  const existingSet = new Set(existing);
  const configuredSet = new Set(configuredNames);
  const toDelete = existing.filter((name) => !configuredSet.has(name));

  for (const name of configuredNames) {
    if (existingSet.has(name)) {
      yield* output.raw(`Bucket already exists: ${name}\n`, "stderr");
      continue;
    }
    yield* output.raw(`Creating analytics bucket: ${name}\n`, "stderr");
    yield* gateway.createAnalyticsBucket(name);
    summary.analytics_created.push(name);
  }

  for (const name of toDelete) {
    const prune = yield* promptYesNo(
      output,
      yes,
      `Bucket ${legacyBold(name)} not found in ${legacyBold(CONFIG_PATH)}. Do you want to prune it?`,
      false,
    );
    if (!prune) {
      continue;
    }
    yield* output.raw(`Pruning analytics bucket: ${name}\n`, "stderr");
    yield* gateway.deleteAnalyticsBucket(name);
    summary.analytics_pruned.push(name);
  }
});

/**
 * Vector graceful-skip (`buckets.go:57-66`): on `FeatureNotEnabled` /
 * local-unavailable errors, print the matching WARNING and continue (object
 * upload still runs). Any other error propagates.
 */
const handleVectorError = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  error: StorageError,
  summary: SeedSummary,
) {
  if (legacyIsVectorBucketsFeatureNotEnabled(error.message)) {
    yield* output.raw(
      `${legacyYellow("WARNING:")} Vector buckets are not available in this project's region yet. Skipping vector bucket seeding.\n`,
      "stderr",
    );
    summary.vector_skipped = true;
    return;
  }
  if (legacyIsLocalVectorBucketsUnavailable(error.message)) {
    yield* output.raw(
      `${legacyYellow("WARNING:")} Vector buckets are not available in the local storage service. If this project is linked, run \`supabase link\` to update service versions, then restart the local stack. Skipping vector bucket seeding.\n`,
      "stderr",
    );
    summary.vector_skipped = true;
    return;
  }
  return yield* Effect.fail(error);
});

// Content-type sniff window: Go reads the first 512 bytes (io.LimitReader,
// `pkg/storage/objects.go:78-79`).
const LEGACY_SNIFF_LEN = 512;

/**
 * Read ONLY the first ≤512 bytes of a file for content-type sniffing, mirroring
 * Go's `io.LimitReader(f, 512)` (`pkg/storage/objects.go:78-79`) — the file is
 * NOT fully buffered (a large object would otherwise stall/OOM before the upload
 * request starts). Opens a handle, reads one sniff window, and closes it via
 * `Effect.scoped`. Returns an empty buffer on EOF (empty file → Go sniffs "" →
 * text/plain) or any read error — an unreadable file then fails at the streaming
 * upload open below, so the sniff result is moot in that case.
 */
const legacyReadSniffBytes = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  absPath: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(absPath, { flag: "r" });
      return yield* handle.readAlloc(LEGACY_SNIFF_LEN);
    }),
  ).pipe(
    Effect.map(Option.getOrElse(() => new Uint8Array(0))),
    Effect.catch(() => Effect.succeed(new Uint8Array(0))),
  );
});

// Port of `pkg/storage/batch.go:UpsertObjects` (+ object walk in objects.go).
const uploadObjects = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  output: typeof Output.Service,
  gateway: LegacyStorageGateway,
  workdir: string,
  bucketsConfig: BucketsConfig,
  summary: SeedSummary,
) {
  for (const [name, bucket] of Object.entries(bucketsConfig)) {
    const objectsPath = bucket.objects_path;
    if (objectsPath.length === 0) {
      continue;
    }
    // Go resolves a relative bucket objects_path against SupabaseDirPath (the
    // `supabase/` dir) at config-resolve time (`pkg/config/config.go:757-759`);
    // absolute paths are left untouched. `@supabase/config` doesn't reproduce
    // this and `workdir` is the project root, so apply the `supabase/` prefix
    // here. `displayRoot` (workdir-relative) drives the `Uploading:` stderr and
    // the destination key so both stay byte-identical to Go.
    const displayRoot = path.isAbsolute(objectsPath)
      ? objectsPath
      : path.join("supabase", objectsPath);
    const absRoot = path.isAbsolute(objectsPath)
      ? objectsPath
      : path.join(workdir, "supabase", objectsPath);
    const files = yield* collectFiles(fs, path, output, absRoot, displayRoot);
    yield* Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const dstPath = legacyBucketObjectKey(name, displayRoot, file.displayPath);
          yield* output.raw(`Uploading: ${file.displayPath} => ${dstPath}\n`, "stderr");
          // Content-type is byte-driven: Go sniffs the first 512 bytes with
          // http.DetectContentType, refining only a generic text/plain by
          // extension (`pkg/storage/objects.go:77-108`). Read the sniff window
          // here (an unreadable file → empty sniff; the streaming open below then
          // surfaces the real error), then stream the full file into the body.
          const sniff = yield* legacyReadSniffBytes(fs, file.absPath);
          // Stream the file into the request body — Go opens the file and streams
          // the io.Reader (`pkg/storage/objects.go:94-127`) rather than buffering
          // each object fully into memory.
          yield* gateway.uploadObject(
            dstPath,
            file.absPath,
            legacyContentTypeForUpload(sniff, file.absPath),
          );
          summary.objects_uploaded.push(dstPath);
        }),
      { concurrency: UPLOAD_CONCURRENCY },
    );
  }
});

/**
 * Collect uploadable files under `absRoot`, lexically ordered, mirroring Go's
 * `fs.WalkDir` + `isUploadableEntry` (`pkg/storage/batch.go:65-131`).
 *
 * Parity details:
 *  - The **root** is resolved with a following stat (Go's `fs.Stat`), so a
 *    symlinked `objects_path` is followed; a missing/dangling root fails the
 *    command, as Go's WalkDir does.
 *  - **Nested** entries use no-follow detection (Go reads `DirEntry` from
 *    `ReadDir`): real directories are descended; symlinks are NOT descended —
 *    Go's `isUploadableEntry` OPENS the symlink target (`fsys.Open`, requiring
 *    read access) then stats the handle, uploading only a regular file and
 *    skipping dangling symlinks / symlinks-to-directories / unreadable targets
 *    with `Skipping non-regular file:` (no crash). Stat alone would queue an
 *    unreadable target and abort later at upload, so the symlink branch opens.
 */
const collectFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  output: typeof Output.Service,
  absRoot: string,
  displayRoot: string,
): Effect.Effect<ReadonlyArray<CollectedFile>, PlatformError> =>
  Effect.gen(function* () {
    const info = yield* fs.stat(absRoot);
    if (info.type === "Directory") {
      return yield* collectDir(fs, path, output, absRoot, displayRoot);
    }
    if (info.type === "File") {
      return [{ absPath: absRoot, displayPath: displayRoot }];
    }
    yield* output.raw(`Skipping non-regular file: ${displayRoot}\n`, "stderr");
    return [];
  });

const collectDir = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  output: typeof Output.Service,
  absDir: string,
  displayDir: string,
): Effect.Effect<ReadonlyArray<CollectedFile>, PlatformError> =>
  Effect.gen(function* () {
    const names = [...(yield* fs.readDirectory(absDir))].sort();
    const collected: Array<CollectedFile> = [];
    for (const name of names) {
      const absChild = path.join(absDir, name);
      const displayChild = path.join(displayDir, name);
      // `readLink` succeeds only on a symlink — our no-follow detector (Effect's
      // `stat` follows symlinks and has no `lstat`).
      const isSymlink = yield* fs.readLink(absChild).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (isSymlink) {
        // Go `isUploadableEntry` (batch.go:73-84) OPENS the target (fsys.Open,
        // requiring read access) then stats the handle; it uploads only a regular
        // file and skips on either an open OR a stat error. `stat` alone follows
        // the link but needs no read permission on the target, so a symlink to an
        // unreadable-but-existing regular file would stat as "File", get queued,
        // then abort the whole run when `uploadObject` opens it to stream. Mirror
        // Go: open + stat, closing the handle (Go's `defer f.Close()`) via
        // `Effect.scoped`. Any open/stat failure falls through to the skip path.
        const targetType = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs.open(absChild, { flag: "r" });
            const targetInfo = yield* handle.stat;
            return targetInfo.type;
          }),
        ).pipe(Effect.catch(() => Effect.succeed("Unknown" as const)));
        if (targetType === "File") {
          collected.push({ absPath: absChild, displayPath: displayChild });
        } else {
          yield* output.raw(`Skipping non-regular file: ${displayChild}\n`, "stderr");
        }
        continue;
      }
      const childInfo = yield* fs.stat(absChild);
      if (childInfo.type === "Directory") {
        collected.push(...(yield* collectDir(fs, path, output, absChild, displayChild)));
      } else if (childInfo.type === "File") {
        collected.push({ absPath: absChild, displayPath: displayChild });
      } else {
        yield* output.raw(`Skipping non-regular file: ${displayChild}\n`, "stderr");
      }
    }
    return collected;
  });
