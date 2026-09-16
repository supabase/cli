import { type CliConfig, CliConfigSchema } from "@supabase/config/effect";
import { loadCliConfig, type InternalLoadCliConfigOptions } from "@supabase/config/internal";
import { Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { PlatformError } from "effect/PlatformError";

import { Output } from "../shared/output/output.service.ts";
import { resolveYesWithProjectEnv } from "./global-flags.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { bold, yellow } from "./colors.ts";
import { loadProjectEnv } from "./db-config.toml-read.ts";
import { shouldSearchAncestors } from "./workdir-search.ts";
import { promptYesNo } from "./prompt-yes-no.ts";
import {
  resolveStorageCredentials,
  storageGatewayFetch,
  validateLocalStorageConfig,
} from "./storage-credentials.ts";
import { parseFileSizeLimit, resolveBucketProps } from "./storage-bucket-config.ts";
import {
  type StorageGateway,
  type UpsertBucketProps,
  makeStorageGateway,
} from "./storage-gateway.ts";
import type { StorageGatewayError } from "./storage-gateway.errors.ts";
import { contentTypeForUpload, readSniffBytes } from "./storage-content-type.ts";
import {
  isLocalVectorBucketsUnavailable,
  isVectorBucketsFeatureNotEnabled,
} from "../commands/seed/buckets/buckets.classify.ts";
import { SeedConfigLoadError } from "../commands/seed/buckets/buckets.errors.ts";
import { bucketObjectKey } from "../commands/seed/buckets/buckets.upload.ts";

const CONFIG_PATH = "supabase/config.toml";
const UPLOAD_CONCURRENCY = 5;

// OS metadata files (macOS Finder, Windows Explorer) that must never be uploaded as seeded
// objects.
const osJunkFileNames = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

// Validates `[storage.buckets]` names before any Storage API call; vector and analytics
// bucket names are not validated here.
const BUCKET_NAME_PATTERN = /^(?:[0-9A-Za-z_]|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

// Kept as a literal string (not derived from `BUCKET_NAME_PATTERN.source`) to keep the error
// message's regex text stable.
const BUCKET_NAME_PATTERN_SOURCE = "^(\\w|!|-|\\.|\\*|'|\\(|\\)| |&|\\$|@|=|;|:|\\+|,|\\?)*$";

const validateBucketName = Effect.fnUntraced(function* (name: string) {
  if (!BUCKET_NAME_PATTERN.test(name)) {
    return yield* new SeedConfigLoadError({
      message: `Invalid Bucket name: ${name}. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed. (${BUCKET_NAME_PATTERN_SOURCE})`,
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

// Embedded-default config, decoded from an empty object — the same decoding the loader
// uses internally. A missing `config.toml` behaves like this default rather than aborting.
const decodeDefaultCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

/**
 * Core of `seed buckets`, shared by the `seed buckets` command and `db reset --local`: loads
 * config (merging `[remotes.<ref>]` for a non-empty `projectRef`), validates bucket config,
 * then upserts buckets + objects against the Storage service gateway.
 *
 * `emitSummary` gates the stdout summary; `interactive` (default `true`) gates overwrite/prune
 * prompts. The caller owns project-ref resolution, cache writes, and telemetry.
 */
export const seedBucketsRun = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
  readonly emitSummary: boolean;
  readonly interactive?: boolean;
  /**
   * Pre-resolved auto-confirm value. `db reset` passes its own value (resolved with the
   * nested project `.env` already loaded) since the internal fallback below only loads
   * whatever the standalone `seed buckets` command's own project would supply. When omitted,
   * falls back to `resolveYesWithProjectEnv`, loading the project env itself.
   */
  readonly yes?: boolean;
  /**
   * Skips this function's own `loadCliConfig` reload in favor of a config the caller
   * already resolved (see `start.handler.ts`'s `effectiveLocalStorageConfig`). Only `start`
   * passes this: it resolves config/env once up front, and a fresh reload here would
   * silently drop any override that exists only in the shell/dotenv, not in `config.toml`.
   */
  readonly resolvedConfig?: {
    readonly config: CliConfig;
    readonly document: Record<string, unknown> | undefined;
  };
  /**
   * Already-resolved nested project dotenv map, when the caller's own config resolution
   * walked it (`db reset`, `start`) — same passthrough idea as `resolvedConfig`. When
   * omitted, loaded once below and shared by the `SUPABASE_YES` fallback and the storage
   * credentials `SUPABASE_API_*` fold.
   */
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectEnvValues =
    opts.projectEnvValues ?? (yield* loadProjectEnv(fs, path, cliSettings.workdir));
  // `--yes` OR `SUPABASE_YES`.
  const yes = opts.yes ?? (yield* resolveYesWithProjectEnv(projectEnvValues));
  const { projectRef, emitSummary } = opts;
  const interactive = opts.interactive ?? true;

  // Loads config.toml, merging `[remotes.*]` overrides for `--linked`; skipped when the
  // caller already supplied `resolvedConfig`.
  const loadOptions: InternalLoadCliConfigOptions =
    projectRef !== ""
      ? { projectRef, goViperCompat: true, search: shouldSearchAncestors(cliSettings) }
      : { goViperCompat: true, search: shouldSearchAncestors(cliSettings) };
  const loaded =
    opts.resolvedConfig !== undefined
      ? null
      : yield* loadCliConfig(cliSettings.workdir, loadOptions).pipe(
          Effect.catchTag(
            "CliConfigParseError",
            (cause) =>
              new SeedConfigLoadError({
                message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
              }),
          ),
        );
  // A missing config file behaves as embedded defaults, not an early exit: local + no-config
  // falls into the no-op short-circuit below, while `--linked` + no-config still falls
  // through to the remote path so auth/project/API failures surface.
  const config =
    opts.resolvedConfig?.config ?? (loaded === null ? decodeDefaultCliConfig({}) : loaded.config);
  const document = opts.resolvedConfig?.document ?? (loaded === null ? undefined : loaded.document);

  // Printed whenever a `[remotes.*]` block matched the linked ref; stderr in all output modes.
  if (loaded !== null && loaded.appliedRemote !== undefined) {
    yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
  }
  const bucketsConfig = config.storage.buckets ?? {};
  const bucketNames = Object.keys(bucketsConfig);
  const vectorEnabled = config.storage.vector.enabled;
  const vectorBucketNames = Object.keys(config.storage.vector.buckets);
  const hasVectorBuckets = vectorBucketNames.length > 0;

  // Config-load-time validations run before the no-op short-circuit, so an invalid value
  // fails even when there's nothing to seed.
  for (const name of bucketNames) {
    yield* validateBucketName(name);
  }

  // Storage-level file_size_limit, parsed unconditionally.
  const storageFileSizeLimitBytes = yield* parseFileSizeLimitOrFail(config.storage.file_size_limit);

  // Per-bucket props (sizes parsed before any Storage call).
  const bucketPropsByName = new Map<string, UpsertBucketProps>();
  for (const [name, bucket] of Object.entries(bucketsConfig)) {
    bucketPropsByName.set(
      name,
      yield* computeBucketProps(document, name, bucket, storageFileSizeLimitBytes),
    );
  }

  // Short-circuit: nothing to seed (ref present → never short-circuits).
  if (projectRef === "" && bucketNames.length === 0 && !hasVectorBuckets) {
    // Config validation (SUPABASE_API_*/SUPABASE_AUTH_* overrides, TLS cert/key pairing)
    // still runs here even with nothing to seed; it's validate-only — the seeding path
    // re-resolves these values through `resolveStorageCredentials`.
    yield* validateLocalStorageConfig(config, projectEnvValues);
    if (emitSummary && output.format !== "text") {
      yield* output.success("", { ...emptySummary() });
    }
    return;
  }

  // Build the Storage service-gateway client (local or remote).
  const credentials = yield* resolveStorageCredentials({
    projectRef,
    config,
    projectEnvValues,
  });

  // Gateway operations use an explicit non-DoH fetch (CA-trusting for local + https, plain
  // `globalThis.fetch` otherwise); the api-keys lookup in `resolveStorageCredentials` runs
  // before this scope, so it still honors `--dns-resolver https`.
  const gatewayOps = Effect.gen(function* () {
    const gateway = yield* makeStorageGateway({
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

    // Machine-readable summary; text mode emits nothing extra.
    if (emitSummary && output.format !== "text") {
      yield* output.success("", { ...summary });
    }
  });

  yield* gatewayOps.pipe(
    Effect.provideService(FetchHttpClient.Fetch, storageGatewayFetch(credentials.localKongCa)),
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

// Parses a `file_size_limit` string to bytes, mapping a parse failure to a config-load error.
const parseFileSizeLimitOrFail = (value: string) =>
  Effect.try({
    try: () => parseFileSizeLimit(value),
    catch: (cause) =>
      new SeedConfigLoadError({
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
    try: () => resolveBucketProps({ document, name, bucket, storageFileSizeLimitBytes }),
    catch: (cause) =>
      new SeedConfigLoadError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

// `propsByName` is precomputed and size-validated before this runs.
const upsertBuckets = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  interactive: boolean,
  gateway: StorageGateway,
  propsByName: ReadonlyMap<string, UpsertBucketProps>,
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
        `Bucket ${bold(bucketId)} already exists. Do you want to overwrite its properties?`,
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

const upsertVectorBuckets = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  interactive: boolean,
  gateway: StorageGateway,
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
      `Bucket ${bold(name)} not found in ${bold(CONFIG_PATH)}. Do you want to prune it?`,
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

const upsertAnalyticsBuckets = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  interactive: boolean,
  gateway: StorageGateway,
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
      `Bucket ${bold(name)} not found in ${bold(CONFIG_PATH)}. Do you want to prune it?`,
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
 * On `FeatureNotEnabled` or local-unavailable errors, prints the matching warning and
 * continues (object upload still runs); any other error propagates.
 */
const handleVectorError = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  error: StorageGatewayError,
  summary: SeedSummary,
) {
  if (isVectorBucketsFeatureNotEnabled(error.message)) {
    yield* output.raw(
      `${yellow("WARNING:")} Vector buckets are not available in this project's region yet. Skipping vector bucket seeding.\n`,
      "stderr",
    );
    summary.vector_skipped = true;
    return;
  }
  if (isLocalVectorBucketsUnavailable(error.message)) {
    yield* output.raw(
      `${yellow("WARNING:")} Vector buckets are not available in the local storage service. If this project is linked, run \`supabase link\` to update service versions, then restart the local stack. Skipping vector bucket seeding.\n`,
      "stderr",
    );
    summary.vector_skipped = true;
    return;
  }
  return yield* Effect.fail(error);
});

const uploadObjects = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  output: typeof Output.Service,
  gateway: StorageGateway,
  workdir: string,
  bucketsConfig: BucketsConfig,
  summary: SeedSummary,
) {
  for (const [name, bucket] of Object.entries(bucketsConfig)) {
    const objectsPath = bucket.objects_path;
    if (objectsPath.length === 0) {
      continue;
    }
    // A relative `objects_path` resolves against the `supabase/` dir; absolute paths are
    // left untouched. `displayRoot` (workdir-relative) drives the `Uploading:` stderr line
    // and the destination key.
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
          const dstPath = bucketObjectKey(name, displayRoot, file.displayPath);
          yield* output.raw(`Uploading: ${file.displayPath} => ${dstPath}\n`, "stderr");
          // Content type is sniffed from the first 512 bytes, refining only a generic
          // text/plain by file extension.
          const sniff = yield* readSniffBytes(fs, file.absPath);
          yield* gateway.uploadObject(dstPath, file.absPath, {
            contentType: contentTypeForUpload(sniff, file.absPath),
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
 * Collects uploadable files under `absRoot`, lexically ordered.
 *
 * The root is resolved with a following stat, so a symlinked `objects_path` is followed; a
 * missing/dangling root fails. Nested entries use no-follow detection: symlinks are opened
 * and their target stat'd, uploading only a regular file and skipping dangling symlinks,
 * symlinks-to-directories, and unreadable targets.
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
      // `readLink` succeeds only on a symlink; Effect's `stat` always follows symlinks and
      // has no `lstat`.
      const isSymlink = yield* fs.readLink(absChild).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (isSymlink) {
        // Opens the target then stats the handle, so an unreadable target is caught now
        // rather than queued and failing later at upload.
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
