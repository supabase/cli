import { type CliConfig, CliConfigSchema } from "@supabase/config/effect";
import { loadCliConfig, type InternalLoadCliConfigOptions } from "@supabase/config/internal";
import { Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { PlatformError } from "effect/PlatformError";

import { Output } from "../../shared/output/output.service.ts";
import { legacyResolveYesWithProjectEnv } from "../../shared/legacy/global-flags.ts";
import { LegacyCliSettings } from "../config/legacy-cli-settings.service.ts";
import { legacyBold, legacyYellow } from "./legacy-colors.ts";
import { legacyLoadProjectEnv } from "./legacy-db-config.toml-read.ts";
import { legacyPromptYesNo } from "../../shared/legacy/legacy-prompt-yes-no.ts";
import {
  legacyResolveStorageCredentials,
  legacyStorageGatewayFetch,
  legacyValidateLocalStorageConfig,
} from "./legacy-storage-credentials.ts";
import {
  legacyParseFileSizeLimit,
  legacyResolveBucketProps,
} from "./legacy-storage-bucket-config.ts";
import {
  type LegacyStorageGateway,
  type LegacyUpsertBucketProps,
  legacyMakeStorageGateway,
} from "./legacy-storage-gateway.ts";
import type { LegacyStorageGatewayError } from "./legacy-storage-gateway.errors.ts";
import { legacyContentTypeForUpload, legacyReadSniffBytes } from "./legacy-storage-content-type.ts";
import {
  legacyIsLocalVectorBucketsUnavailable,
  legacyIsVectorBucketsFeatureNotEnabled,
} from "../commands/seed/buckets/buckets.classify.ts";
import { LegacySeedConfigLoadError } from "../commands/seed/buckets/buckets.errors.ts";
import { legacyBucketObjectKey } from "../commands/seed/buckets/buckets.upload.ts";

const CONFIG_PATH = "supabase/config.toml";
const UPLOAD_CONCURRENCY = 5;

/**
 * Well-known OS metadata files (macOS Finder, Windows Explorer) that must
 * never be uploaded as seeded objects — see CLI-1950. Go has no equivalent
 * skip; this is an intentional TS-only improvement over Go's current (also
 * buggy) behavior.
 */
const osJunkFileNames = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Mirrors `ValidateBucketName` regex.
 * Used to validate `[storage.buckets]` names before any Storage API call, matching
 * Go's config-load-time check. Vector and analytics names are
 * NOT validated here — Go only validates `[storage.buckets]`.
 */
const LEGACY_BUCKET_NAME_PATTERN = /^(?:[0-9A-Za-z_]|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

/**
 * Verbatim Go regex literal — used in the error message so it
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
 * `decodeUnknownSync(CliConfigSchema)({})` the loader uses internally
 * (`packages/config/src/io.ts:54-56`). `seed buckets` never aborts on a
 * missing `config.toml`: it reads the package-global `utils.Config`, initialized
 * to embedded defaults, and `config.Load` no-ops on a missing file. So "no
 * config file" behaves like the embedded-default config.
 */
const legacyDecodeDefaultCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

/**
 * Core of `seed buckets`: load config (merging `[remotes.<ref>]` for a non-empty
 * `projectRef`), validate bucket config, then upsert/seed buckets + objects against
 * the Storage service gateway. Hoisted to `legacy/shared/` so both the `seed
 * buckets` command and `db reset --local` can reuse the exact local-seed path Go
 * invokes via `buckets.Run(ctx, "", false, fsys)`.
 *
 * `emitSummary` controls whether the machine-readable summary is written to stdout:
 * the `seed buckets` command emits it; `db reset` does NOT (it emits its own
 * result), matching Go where reset's `buckets.Run` prints nothing to stdout.
 *
 * `interactive` controls whether overwrite/prune confirmations may prompt. `db
 * reset` reuses this core with `interactive: false` so it never blocks on input —
 * Go forces it via `buckets.Run(ctx, "", false, fsys)`. Defaults to `true`.
 *
 * The caller owns project-ref resolution, the linked-project cache write, and the
 * telemetry flush (Go's PersistentPostRun) — this core does none of those.
 */
export const legacySeedBucketsRun = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
  readonly emitSummary: boolean;
  readonly interactive?: boolean;
  /**
   * Pre-resolved auto-confirm value. `db reset` resolves `yes` with the nested project
   * `.env` loaded (`loadNestedEnv` runs before `buckets.Run`), so pass it through here —
   * the internal fallback below only loads whatever THIS command's own project would
   * supply. When omitted (the standalone `seed buckets` command), fall back to
   * `legacyResolveYesWithProjectEnv`, loading the project env ourselves — `seed buckets`
   * defaults to `--local` (`seedFlags.Bool("local", true, ...)`),
   * and root's `ParseDatabaseConfig` calls `LoadConfig` — loading the project `.env` files —
   * before `buckets.Run`'s overwrite/prune prompts, so a `SUPABASE_YES`
   * set only in `supabase/.env` must auto-confirm here too.
   */
  readonly yes?: boolean;
  /**
   * Skips this function's own `loadCliConfig` reload in favor of a config
   * the caller already resolved (and may have folded env overrides into —
   * see `start.handler.ts`'s `effectiveLocalStorageConfig`). `buckets.Run`
   * never reloads config itself: it reads the single process-wide `utils.Config`
   * populated once by `Config.Load()` at CLI startup, so any `SUPABASE_*`
   * override already in effect for the rest of that process (e.g. an
   * env-overridden `api.port`/`api.tls.enabled` that actually brought Kong up
   * differently) is automatically visible here too. `start` is a long-running
   * process that resolves its own config/env once up front and must reuse
   * that SAME resolution for bucket seeding to match — an independent reload
   * from disk would silently drop any override that exists only in the
   * shell/dotenv, not literally in config.toml. Only `start` passes this;
   * the standalone `seed buckets` command's own single load already IS the
   * one-shot `Config.Load()` for that process, so it keeps reloading below.
   */
  readonly resolvedConfig?: {
    readonly config: CliConfig;
    readonly document: Record<string, unknown> | undefined;
  };
  /**
   * Already-resolved nested project dotenv map, when the caller's own config
   * resolution walked it (`db reset`'s context, `start`) — same passthrough
   * idea as `resolvedConfig` above. When omitted (the standalone command),
   * loaded once below and shared by the `SUPABASE_YES` fallback and the
   * storage credentials `SUPABASE_API_*` fold.
   */
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}) {
  const output = yield* Output;
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectEnvValues =
    opts.projectEnvValues ?? (yield* legacyLoadProjectEnv(fs, path, cliSettings.workdir));
  // `--yes` OR `SUPABASE_YES`.
  const yes = opts.yes ?? (yield* legacyResolveYesWithProjectEnv(projectEnvValues));
  const { projectRef, emitSummary } = opts;
  const interactive = opts.interactive ?? true;

  // Load config.toml, passing projectRef so `[remotes.*]` overrides are merged for
  // --linked. A parse failure aborts before any network call. Skipped entirely
  // when the caller already supplied `resolvedConfig` — see that option's doc
  // comment above.
  const loadOptions: InternalLoadCliConfigOptions =
    projectRef !== "" ? { projectRef, goViperCompat: true } : { goViperCompat: true };
  const loaded =
    opts.resolvedConfig !== undefined
      ? null
      : yield* loadCliConfig(cliSettings.workdir, loadOptions).pipe(
          Effect.catchTag(
            "CliConfigParseError",
            (cause) =>
              new LegacySeedConfigLoadError({
                message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
              }),
          ),
        );
  // A missing config file is NOT an early exit: Go uses embedded defaults and
  // still gates the no-op on `len(projectRef) == 0`. So local + no-config falls
  // into the no-op short-circuit; `--linked` + no-config falls through to the
  // remote path so auth/project/API failures surface. `resolvedConfig` (when
  // given) always wins over a `null` `loaded` — see that option's doc comment.
  const config =
    opts.resolvedConfig?.config ??
    (loaded === null ? legacyDecodeDefaultCliConfig({}) : loaded.config);
  const document = opts.resolvedConfig?.document ?? (loaded === null ? undefined : loaded.document);

  // Go prints this from inside config load whenever a
  // `[remotes.*]` block matched the linked ref. stderr in all output modes.
  if (loaded !== null && loaded.appliedRemote !== undefined) {
    yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
  }
  const bucketsConfig = config.storage.buckets ?? {};
  const bucketNames = Object.keys(bucketsConfig);
  const vectorEnabled = config.storage.vector.enabled;
  const vectorBucketNames = Object.keys(config.storage.vector.buckets);
  const hasVectorBuckets = vectorBucketNames.length > 0;

  // Config-load-time validations run BEFORE the no-op short-circuit: Go decodes the
  // whole config (storage.FileSizeLimit, bucket sizes) and runs ValidateBucketName
  // during config.Load — before `buckets.Run` can take its no-op path — so an
  // invalid value fails even when there's nothing to seed.
  //
  // Bucket names (`ValidateBucketName`).
  for (const name of bucketNames) {
    yield* legacyValidateBucketName(name);
  }

  // Storage-level file_size_limit, parsed unconditionally.
  const storageFileSizeLimitBytes = yield* parseFileSizeLimitOrFail(config.storage.file_size_limit);

  // Per-bucket props (sizes parsed before any Storage call).
  const bucketPropsByName = new Map<string, LegacyUpsertBucketProps>();
  for (const [name, bucket] of Object.entries(bucketsConfig)) {
    bucketPropsByName.set(
      name,
      yield* computeBucketProps(document, name, bucket, storageFileSizeLimitBytes),
    );
  }

  // Short-circuit: nothing to seed (ref present → never short-circuits).
  if (projectRef === "" && bucketNames.length === 0 && !hasVectorBuckets) {
    // The `SUPABASE_API_*`/`SUPABASE_AUTH_*` override decode belongs to config
    // load, which runs before the no-op path — a malformed override, invalid
    // `api.port`, short or undecryptable auth secret, or broken TLS cert/key
    // pairing fails even with nothing to seed, same as the bucket-name/size
    // validations above. Validate-only: the seeding path re-resolves the same
    // values through `legacyResolveStorageCredentials`.
    yield* legacyValidateLocalStorageConfig(config, projectEnvValues);
    if (emitSummary && output.format !== "text") {
      yield* output.success("", { ...emptySummary() });
    }
    return;
  }

  // Build the Storage service-gateway client (local or remote).
  const credentials = yield* legacyResolveStorageCredentials({
    projectRef,
    config,
    projectEnvValues,
  });

  // All gateway operations run with an explicit non-DoH fetch (CA-trusting for
  // local + https, plain `globalThis.fetch` otherwise). The api-keys lookup inside
  // `legacyResolveStorageCredentials` runs BEFORE this scope, so it still honors
  // `--dns-resolver https`, matching `tenant.GetApiKeys`.
  const gatewayOps = Effect.gen(function* () {
    const gateway = yield* legacyMakeStorageGateway({
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      userAgent: cliSettings.userAgent,
    });

    const summary = emptySummary();

    yield* upsertBuckets(output, yes, interactive, gateway, bucketPropsByName, summary);

    // Upsert analytics buckets (remote --linked only).
    if (config.storage.analytics.enabled && projectRef !== "") {
      yield* output.raw("Updating analytics buckets...\n", "stderr");
      yield* upsertAnalyticsBuckets(
        output,
        yes,
        interactive,
        gateway,
        Object.keys(config.storage.analytics.buckets),
        summary,
      );
    }

    // Upsert vector buckets (local), with graceful skip on unavailability.
    if (vectorEnabled && hasVectorBuckets) {
      yield* output.raw("Updating vector buckets...\n", "stderr");
      yield* upsertVectorBuckets(
        output,
        yes,
        interactive,
        gateway,
        vectorBucketNames,
        summary,
      ).pipe(Effect.catch((error) => handleVectorError(output, error, summary)));
    }

    // Upload objects for each bucket with a configured objects_path.
    yield* uploadObjects(fs, path, output, gateway, cliSettings.workdir, bucketsConfig, summary);

    // Machine-readable summary (Go has none; text mode emits nothing extra).
    if (emitSummary && output.format !== "text") {
      yield* output.success("", { ...summary });
    }
  });

  yield* gatewayOps.pipe(
    Effect.provideService(
      FetchHttpClient.Fetch,
      legacyStorageGatewayFetch(credentials.localKongCa),
    ),
  );
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

const computeBucketProps = (
  document: Record<string, unknown> | undefined,
  name: string,
  bucket: BucketsConfig[string],
  storageFileSizeLimitBytes: number,
) =>
  Effect.try({
    try: () => legacyResolveBucketProps({ document, name, bucket, storageFileSizeLimitBytes }),
    catch: (cause) =>
      new LegacySeedConfigLoadError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

// Port of `pkg/storage/batch.go:UpsertBuckets`. `propsByName` is precomputed and
// size-validated before this runs (Go parses sizes at config-load, before any
// Storage call).
const upsertBuckets = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  interactive: boolean,
  gateway: LegacyStorageGateway,
  propsByName: ReadonlyMap<string, LegacyUpsertBucketProps>,
  summary: SeedSummary,
) {
  const existing = yield* gateway.listBuckets();
  const byName = new Map(existing.map((b) => [b.name, b.id]));

  for (const [name, props] of propsByName) {
    const bucketId = byName.get(name);
    if (bucketId !== undefined) {
      const overwrite = yield* legacyPromptYesNo(
        output,
        yes,
        `Bucket ${legacyBold(bucketId)} already exists. Do you want to overwrite its properties?`,
        true,
        interactive,
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
  interactive: boolean,
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
    const prune = yield* legacyPromptYesNo(
      output,
      yes,
      `Bucket ${legacyBold(name)} not found in ${legacyBold(CONFIG_PATH)}. Do you want to prune it?`,
      false,
      interactive,
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
  interactive: boolean,
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
    const prune = yield* legacyPromptYesNo(
      output,
      yes,
      `Bucket ${legacyBold(name)} not found in ${legacyBold(CONFIG_PATH)}. Do you want to prune it?`,
      false,
      interactive,
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
 * Vector graceful-skip: on `FeatureNotEnabled` /
 * local-unavailable errors, print the matching WARNING and continue (object
 * upload still runs). Any other error propagates.
 */
const handleVectorError = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  error: LegacyStorageGatewayError,
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
    // Go resolves a relative bucket objects_path against SupabaseDirPath at
    // config-resolve time; absolute paths are
    // left untouched. `displayRoot` (workdir-relative) drives the `Uploading:`
    // stderr and the destination key so both stay byte-identical to Go.
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
          // extension.
          const sniff = yield* legacyReadSniffBytes(fs, file.absPath);
          // Go's seed upload always sets Cache-Control max-age=3600 and x-upsert
          // (Overwrite) true (`pkg/storage/batch.go`).
          yield* gateway.uploadObject(dstPath, file.absPath, {
            contentType: legacyContentTypeForUpload(sniff, file.absPath),
            cacheControl: "max-age=3600",
            overwrite: true,
          });
          summary.objects_uploaded.push(dstPath);
        }),
      { concurrency: UPLOAD_CONCURRENCY },
    );
  }
});

/**
 * Collect uploadable files under `absRoot`, lexically ordered, mirroring Go's
 * `fs.WalkDir` + `isUploadableEntry`.
 *
 * Parity details:
 * - The **root** is resolved with a following stat (`fs.Stat`), so a
 * symlinked `objects_path` is followed; a missing/dangling root fails.
 * - **Nested** entries use no-follow detection: real directories are descended;
 * symlinks are NOT descended — `isUploadableEntry` OPENS the symlink
 * target then stats the handle, uploading only a regular file and skipping
 * dangling symlinks / symlinks-to-directories / unreadable targets.
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
      if (osJunkFileNames.has(path.basename(displayRoot))) {
        yield* output.raw(`Skipping OS metadata file: ${displayRoot}\n`, "stderr");
        return [];
      }
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
      if (osJunkFileNames.has(name)) {
        yield* output.raw(`Skipping OS metadata file: ${displayChild}\n`, "stderr");
        continue;
      }
      // `readLink` succeeds only on a symlink — our no-follow detector (Effect's
      // `stat` follows symlinks and has no `lstat`).
      const isSymlink = yield* fs.readLink(absChild).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (isSymlink) {
        // `isUploadableEntry` OPENS the target then stats the
        // handle; it uploads only a regular file. `stat` alone would queue an
        // unreadable target and abort later at upload, so mirror that: open + stat.
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
