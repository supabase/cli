import type { CliConfig } from "@supabase/config/effect";
import { Data, Effect } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { parseFileSizeLimit, resolveBucketProps } from "./storage-bucket-config.ts";

/** A configured bucket `file_size_limit` is invalid or larger than `[storage] file_size_limit`. */
class StorageBucketFileSizeLimitError extends Data.TaggedError("StorageBucketFileSizeLimitError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

const exceedingBuckets = (config: CliConfig, document: Record<string, unknown> | undefined) => {
  const storageFileSizeLimitBytes = parseFileSizeLimit(config.storage.file_size_limit);
  return Object.entries(config.storage.buckets ?? {}).filter(
    ([name, bucket]) =>
      resolveBucketProps({ document, name, bucket, storageFileSizeLimitBytes }).fileSizeLimit >
      storageFileSizeLimitBytes,
  );
};

/**
 * Fails when a configured bucket's `file_size_limit` is larger than `[storage] file_size_limit`,
 * the global upload limit Storage enforces when the bucket is created.
 */
export const checkBucketFileSizeLimits = Effect.fn("Storage.checkBucketFileSizeLimits")(
  function* (opts: {
    readonly config: CliConfig;
    readonly document: Record<string, unknown> | undefined;
  }) {
    const exceeding = yield* Effect.try({
      try: () => exceedingBuckets(opts.config, opts.document),
      catch: (cause) =>
        new StorageBucketFileSizeLimitError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    if (exceeding.length === 0) return;
    return yield* new StorageBucketFileSizeLimitError({
      message: [
        ...exceeding.map(
          ([name, bucket]) =>
            `storage.buckets.${name}.file_size_limit (${bucket.file_size_limit}) exceeds storage.file_size_limit (${opts.config.storage.file_size_limit}).`,
        ),
        "Raise storage.file_size_limit or lower the bucket limit.",
      ].join("\n"),
    });
  },
);
