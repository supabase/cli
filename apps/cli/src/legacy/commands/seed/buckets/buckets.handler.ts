import {
  loadProjectConfig,
  type LoadProjectConfigOptions,
  ProjectConfigSchema,
} from "@supabase/config";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { PlatformError } from "effect/PlatformError";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacySeedChangedTargetFlags } from "./buckets.flags.ts";
import { legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import {
  legacyResolveStorageCredentials,
  legacyStorageGatewayFetch,
} from "../../../shared/legacy-storage-credentials.ts";
import {
  legacyParseFileSizeLimit,
  legacyResolveBucketProps,
} from "../../../shared/legacy-storage-bucket-config.ts";
import {
  type LegacyStorageGateway,
  type LegacyUpsertBucketProps,
  legacyMakeStorageGateway,
} from "../../../shared/legacy-storage-gateway.ts";
import type { LegacyStorageGatewayError } from "../../../shared/legacy-storage-gateway.errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  legacyIsLocalVectorBucketsUnavailable,
  legacyIsVectorBucketsFeatureNotEnabled,
} from "./buckets.classify.ts";
import { LegacySeedConfigLoadError } from "./buckets.errors.ts";
import { legacyBucketObjectKey } from "./buckets.upload.ts";
import { legacyPromptYesNo } from "../../../shared/legacy-prompt-yes-no.ts";
import {
  legacyContentTypeForUpload,
  legacyReadSniffBytes,
} from "../../../shared/legacy-storage-content-type.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyBucketsFlags } from "./buckets.command.ts";

const CONFIG_PATH = "supabase/config.toml";
const UPLOAD_CONCURRENCY = 5;

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
 * missing `config.toml`: it reads the package-global `utils.Config`, initialized
 * to embedded defaults, and `config.Load` no-ops on a missing file. So "no
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
  // `--yes` OR `SUPABASE_YES` (Go's viper AutomaticEnv, root.go:318-320).
  const yes = yield* legacyResolveYes;

  // Set once --linked resolves a ref; drives the post-run linked-project cache
  // write + org/project group identify, mirroring Go's `ensureProjectGroupsCached`
  // (`cmd/root.go`, gated on a non-empty `flags.ProjectRef`). Empty on the local
  // path, so the cache is never written there.
  let linkedRef = "";

  yield* Effect.gen(function* () {
    // 1. Resolve the project ref for --linked BEFORE loading config, so that
    // the matching `[remotes.<name>]` override (whose `project_id == ref`) is
    // merged over the base config by `loadProjectConfig`. Go selects the target
    // from `flag.Changed`, not the flag value: `--linked` is the linked path
    // whenever it's *set* (even `--linked=false`).
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
    // still gates the no-op on `len(projectRef) == 0`. So local + no-config falls
    // into the no-op short-circuit; `--linked` + no-config falls through to the
    // remote path so auth/project/API failures surface.
    const config = loaded === null ? legacyDecodeDefaultProjectConfig({}) : loaded.config;
    const document = loaded === null ? undefined : loaded.document;

    // Go prints this from inside config load (`config.go:513`) whenever a
    // `[remotes.*]` block matched the linked ref. stderr in all output modes.
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

    // 3b. Storage-level file_size_limit, parsed unconditionally.
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
      if (output.format !== "text") {
        yield* output.success("", { ...emptySummary() });
      }
      return;
    }

    // 4. Build the Storage service-gateway client (local or remote).
    const credentials = yield* legacyResolveStorageCredentials({ projectRef, config });

    // All gateway operations run with an explicit non-DoH fetch (CA-trusting for
    // local + https, plain `globalThis.fetch` otherwise). The api-keys lookup
    // inside `legacyResolveStorageCredentials` runs BEFORE this scope, so it
    // still honors `--dns-resolver https`, matching Go's `tenant.GetApiKeys`.
    const gatewayOps = Effect.gen(function* () {
      const gateway = yield* legacyMakeStorageGateway({
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
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

    yield* gatewayOps.pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        legacyStorageGatewayFetch(credentials.localKongCa),
      ),
    );
  }).pipe(
    // Go's root `Execute` caches the linked project + fires org/project group
    // identify whenever `flags.ProjectRef` is set — only on the --linked path.
    Effect.ensuring(
      Effect.suspend(() => (linkedRef === "" ? Effect.void : linkedProjectCache.cache(linkedRef))),
    ),
    Effect.ensuring(telemetryState.flush),
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
    const prune = yield* legacyPromptYesNo(
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
    const prune = yield* legacyPromptYesNo(
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
    // config-resolve time (`pkg/config/config.go:757-759`); absolute paths are
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
          // extension (`pkg/storage/objects.go:77-108`).
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
 * `fs.WalkDir` + `isUploadableEntry` (`pkg/storage/batch.go:65-131`).
 *
 * Parity details:
 *  - The **root** is resolved with a following stat (Go's `fs.Stat`), so a
 *    symlinked `objects_path` is followed; a missing/dangling root fails.
 *  - **Nested** entries use no-follow detection: real directories are descended;
 *    symlinks are NOT descended — Go's `isUploadableEntry` OPENS the symlink
 *    target then stats the handle, uploading only a regular file and skipping
 *    dangling symlinks / symlinks-to-directories / unreadable targets.
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
        // Go `isUploadableEntry` (batch.go:73-84) OPENS the target then stats the
        // handle; it uploads only a regular file. `stat` alone would queue an
        // unreadable target and abort later at upload, so mirror Go: open + stat.
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
