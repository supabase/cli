import {
  KONG_LOCAL_CA_CERT,
  loadProjectConfig,
  type LoadProjectConfigOptions,
} from "@supabase/config";
import { defaultJwtSecret, generateJwt } from "@supabase/stack/effect";
import { Effect, FileSystem, Option, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { PlatformError } from "effect/PlatformError";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyGetProjectApiKeys } from "../../../shared/legacy-get-api-keys.ts";
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
  makeLegacyStorageGateway,
} from "./buckets.gateway.ts";
import {
  LegacySeedConfigLoadError,
  LegacySeedMissingApiKeyError,
  LegacySeedStorageNetworkError,
  LegacySeedStorageStatusError,
} from "./buckets.errors.ts";
import {
  legacyBucketObjectKey,
  legacyContentTypeForPath,
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
 * Only called when `projectRef === ""` (local) AND `config.api.tls.enabled`.
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
    const absCert = path.isAbsolute(certPath) ? certPath : path.join(workdir, "supabase", certPath);
    const certContent = yield* fs.readFileString(absCert).pipe(
      Effect.catchTag(
        "PlatformError",
        (cause) =>
          new LegacySeedConfigLoadError({
            message: `failed to read TLS cert: ${String(cause.cause ?? cause)}`,
          }),
      ),
    );
    // keyPath is non-empty here because hasKey === true (cert+key both present)
    const absKey = path.isAbsolute(keyPath!) ? keyPath! : path.join(workdir, "supabase", keyPath!);
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
    if (loaded === null) {
      return;
    }
    const config = loaded.config;
    const bucketsConfig = config.storage.buckets ?? {};
    const bucketNames = Object.keys(bucketsConfig);
    const vectorEnabled = config.storage.vector.enabled;
    const vectorBucketNames = Object.keys(config.storage.vector.buckets);
    const hasVectorBuckets = vectorBucketNames.length > 0;

    // 3. Short-circuit: nothing to seed (ref present → never short-circuits).
    if (projectRef === "" && bucketNames.length === 0 && !hasVectorBuckets) {
      // Go emits nothing in text mode; in the additive json/stream-json modes a
      // scripted caller still expects a result object, so emit an empty summary.
      if (output.format !== "text") {
        yield* output.success("", { ...emptySummary() });
      }
      return;
    }

    // 3a. Validate bucket names up front (Go ValidateBucketName, config.go:899-903),
    // before `computeBucketProps` or any Storage call.
    for (const name of bucketNames) {
      yield* legacyValidateBucketName(name);
    }

    // 3b. Parse the storage-level file_size_limit once, up front and
    // unconditionally — Go unmarshals `storage.FileSizeLimit` during
    // config.Load, so an invalid value (e.g. "bogus") aborts before any Storage
    // call even when no bucket inherits it or only vector buckets are configured.
    const storageFileSizeLimitBytes = yield* parseFileSizeLimitOrFail(
      config.storage.file_size_limit,
    );

    // 3c. Resolve + validate every bucket's props up front (Go parses sizes at
    // config-load, before NewStorageAPI), so an invalid/omitted file_size_limit
    // is settled before any Storage list/create/update.
    const bucketPropsByName = new Map<string, LegacyUpsertBucketProps>();
    for (const [name, bucket] of Object.entries(bucketsConfig)) {
      bucketPropsByName.set(
        name,
        yield* computeBucketProps(loaded.document, name, bucket, storageFileSizeLimitBytes),
      );
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
        const keys = legacyExtractServiceKeys(yield* legacyGetProjectApiKeys(projectRef, true));
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
    // — its embedded CA only matters for https — and `(*api).Validate` reads
    // `cert_path` and validates the cert/key pairing only when `api.tls.enabled`
    // (`config.go:845-861`). So: validate (and resolve a cert_path CA) when
    // tls is enabled; inject the CA whenever the resolved local URL is https
    // (covering an explicit `https` `api.external_url` with `tls.enabled` false →
    // embedded CA), and never for the remote `--linked` host.
    let localKongCa: string | undefined;
    if (projectRef === "") {
      const validatedCa = config.api.tls.enabled
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

    // All gateway operations are wrapped in a CA-aware fetch context when
    // running against a local TLS stack. `FetchHttpClient.Fetch` is read per
    // request from the fiber context (`fiber.getRef(Fetch)` in FetchHttpClient),
    // so `Effect.provideService` at this scope correctly overrides it for every
    // HTTP call the gateway makes.
    const gatewayOps = Effect.gen(function* () {
      const gateway = yield* makeLegacyStorageGateway({
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

    // Provide a CA-trusting fetch for all gateway HTTP calls when local + TLS.
    yield* localKongCa !== undefined
      ? gatewayOps.pipe(
          Effect.provideService(FetchHttpClient.Fetch, legacyKongCaFetch(localKongCa)),
        )
      : gatewayOps;
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
          // Stream the file into the request body — Go opens the file and streams
          // the io.Reader (`pkg/storage/objects.go:94-127`) rather than buffering
          // each object fully into memory.
          yield* gateway.uploadObject(
            dstPath,
            file.absPath,
            legacyContentTypeForPath(file.absPath),
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
 *    Go's `isUploadableEntry` uploads a symlink only when its target is a
 *    regular file, and skips dangling symlinks / symlinks-to-directories /
 *    other non-regular entries with `Skipping non-regular file:` (no crash).
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
        // Go `isUploadableEntry`: open + stat the target; upload only a regular
        // file, otherwise skip (covers dangling symlinks and symlink-to-dir).
        const targetType = yield* fs.stat(absChild).pipe(
          Effect.map((i) => i.type),
          Effect.catch(() => Effect.succeed("Unknown" as const)),
        );
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
