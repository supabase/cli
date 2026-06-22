import { loadProjectConfig } from "@supabase/config";
import { defaultJwtSecret, generateJwt } from "@supabase/stack/effect";
import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacySeedChangedTargetFlags } from "./buckets.flags.ts";
import { legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
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
  LegacySeedMutuallyExclusiveFlagsError,
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
  };
}

/**
 * `supabase seed buckets` — seeds the **local** Storage stack from
 * `[storage.buckets]` / `[storage.vector]` in `supabase/config.toml`.
 *
 * Port of `apps/cli-go/internal/seed/buckets/buckets.go`. Local-only: Go's
 * `seed` command never resolves a project ref (see `seed.layers.ts`), so the
 * remote / analytics paths are unreachable and omitted.
 */
export const legacySeedBuckets = Effect.fn("legacy.seed.buckets")(function* (
  _flags: LegacyBucketsFlags,
) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliArgs = yield* CliArgs;

  yield* Effect.gen(function* () {
    // 0. Reproduce cobra's MarkFlagsMutuallyExclusive("local", "linked").
    const setFlags = legacySeedChangedTargetFlags(cliArgs.args);
    if (setFlags.length > 1) {
      return yield* new LegacySeedMutuallyExclusiveFlagsError({
        message: `if any flags in the group [linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
      });
    }

    // 1. Load config.toml. A parse failure aborts before any network call.
    const loaded = yield* loadProjectConfig(cliConfig.workdir).pipe(
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

    // 2. Short-circuit: nothing to seed (projectRef is always empty locally).
    if (bucketNames.length === 0 && !hasVectorBuckets) {
      return;
    }

    // 3. Build the local Storage service-gateway client.
    const baseUrl = resolveLocalBaseUrl(config);
    const apiKey =
      config.auth.service_role_key ??
      generateJwt(config.auth.jwt_secret ?? defaultJwtSecret, "service_role");
    const gateway = yield* makeLegacyStorageGateway({
      baseUrl,
      apiKey,
      userAgent: cliConfig.userAgent,
    });

    const summary = emptySummary();

    // 4. Upsert configured buckets.
    yield* upsertBuckets(output, gateway, bucketsConfig, summary);

    // 5. Upsert vector buckets (local), with graceful skip on unavailability.
    if (vectorEnabled && hasVectorBuckets) {
      yield* output.raw("Updating vector buckets...\n", "stderr");
      yield* upsertVectorBuckets(output, gateway, vectorBucketNames, summary).pipe(
        Effect.catch((error) => handleVectorError(output, error, summary)),
      );
    }

    // 6. Upload objects for each bucket with a configured objects_path.
    yield* uploadObjects(fs, path, output, gateway, cliConfig.workdir, bucketsConfig, summary);

    // 7. Machine-readable summary (Go has none; text mode emits nothing extra).
    if (output.format !== "text") {
      yield* output.success("", { ...summary });
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});

/**
 * Local API URL, mirroring Go's `config.go:634-644` + `misc.go:298`: an explicit
 * `api.external_url` wins, otherwise `<scheme>://<host>:<port>` where the scheme
 * follows `api.tls.enabled`, the host is `SUPABASE_SERVICES_HOSTNAME` (or
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
  const host = process.env["SUPABASE_SERVICES_HOSTNAME"] ?? "127.0.0.1";
  const scheme = config.api.tls.enabled ? "https" : "http";
  return `${scheme}://${host}:${config.api.port}`;
}

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

function bucketProps(bucket: BucketsConfig[string]): LegacyUpsertBucketProps {
  return {
    public: bucket.public,
    fileSizeLimit: legacyParseFileSizeLimit(bucket.file_size_limit),
    allowedMimeTypes: bucket.allowed_mime_types,
  };
}

/**
 * Confirm-or-default prompt mirroring Go's `console.PromptYesNo`: a real TTY in
 * text mode prompts; everything else (non-interactive, json/stream-json) uses
 * the default without printing.
 */
const promptYesNo = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  label: string,
  defaultValue: boolean,
) {
  if (output.format !== "text") {
    return defaultValue;
  }
  return yield* output
    .promptConfirm(label, { defaultValue })
    .pipe(Effect.catchTag("NonInteractiveError", () => Effect.succeed(defaultValue)));
});

// Port of `pkg/storage/batch.go:UpsertBuckets`.
const upsertBuckets = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  gateway: LegacyStorageGateway,
  bucketsConfig: BucketsConfig,
  summary: SeedSummary,
) {
  const existing = yield* gateway.listBuckets();
  const byName = new Map(existing.map((b) => [b.name, b.id]));

  for (const [name, bucket] of Object.entries(bucketsConfig)) {
    const bucketId = byName.get(name);
    if (bucketId !== undefined) {
      const overwrite = yield* promptYesNo(
        output,
        `Bucket ${legacyBold(bucketId)} already exists. Do you want to overwrite its properties?`,
        true,
      );
      if (!overwrite) {
        summary.buckets_skipped.push(bucketId);
        continue;
      }
      yield* output.raw(`Updating Storage bucket: ${bucketId}\n`, "stderr");
      yield* gateway.updateBucket(bucketId, bucketProps(bucket));
      summary.buckets_updated.push(bucketId);
    } else {
      yield* output.raw(`Creating Storage bucket: ${name}\n`, "stderr");
      yield* gateway.createBucket(name, bucketProps(bucket));
      summary.buckets_created.push(name);
    }
  }
});

// Port of `pkg/storage/vector.go:UpsertVectorBuckets`.
const upsertVectorBuckets = Effect.fnUntraced(function* (
  output: typeof Output.Service,
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
    const absRoot = path.resolve(workdir, objectsPath);
    const files = yield* collectFiles(fs, path, output, absRoot, objectsPath);
    yield* Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const dstPath = legacyBucketObjectKey(name, objectsPath, file.displayPath);
          yield* output.raw(`Uploading: ${file.displayPath} => ${dstPath}\n`, "stderr");
          const bytes = yield* fs.readFile(file.absPath);
          yield* gateway.uploadObject(dstPath, bytes, legacyContentTypeForPath(file.absPath));
          summary.objects_uploaded.push(dstPath);
        }),
      { concurrency: UPLOAD_CONCURRENCY },
    );
  }
});

/**
 * Recursively collect regular files under `absRoot`, lexically ordered (Go's
 * `fs.WalkDir`). `displayRoot` is the config-relative path Go prints in the
 * `Uploading:` line. Non-regular entries are skipped with Go's
 * `Skipping non-regular file:` notice.
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
      const names = [...(yield* fs.readDirectory(absRoot))].sort();
      const collected: Array<CollectedFile> = [];
      for (const name of names) {
        const nested = yield* collectFiles(
          fs,
          path,
          output,
          path.join(absRoot, name),
          path.join(displayRoot, name),
        );
        collected.push(...nested);
      }
      return collected;
    }
    if (info.type === "File") {
      return [{ absPath: absRoot, displayPath: displayRoot }];
    }
    yield* output.raw(`Skipping non-regular file: ${displayRoot}\n`, "stderr");
    return [];
  });
