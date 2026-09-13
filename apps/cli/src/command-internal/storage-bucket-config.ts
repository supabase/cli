import { ramInBytes } from "./size-units.ts";
import type { UpsertBucketProps } from "./storage-gateway.ts";

/**
 * Pure helpers that turn a `[storage.buckets.*]` config entry into the create/update bucket
 * props the Storage gateway sends. Shared by `seed buckets` and `storage cp` (which
 * auto-creates a bucket on a `Bucket not found` upload). Kept free of Effect/services so the
 * size-parsing, storage-level-inheritance, and `public` tri-state rules stay unit-testable.
 */

/**
 * Parses a `file_size_limit` config string (e.g. `"50MiB"`) to the byte count sent in the
 * create/update bucket body. Throws on an unparseable value; the caller maps that to a
 * config-load error.
 */
export function parseFileSizeLimit(sizeStr: string): number {
  return ramInBytes(sizeStr);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the bucket's TOML entry explicitly declares `key`. The decoded config loses this
 * signal (an absent key decodes to the schema default), but it drives the `public` tri-state
 * and the storage-level `file_size_limit` inheritance, so recover presence from the raw
 * (post-`env()`) document instead.
 */
export function bucketHasKey(
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

interface BucketConfigEntry {
  readonly public: boolean;
  readonly file_size_limit: string;
  readonly allowed_mime_types: ReadonlyArray<string>;
}

/**
 * Resolves a bucket's create/update props: an omitted or zero `file_size_limit` inherits the
 * (already-parsed) storage-level limit; `public` is the explicit value only when the TOML
 * declares it, else `undefined` (omitted from the request body).
 *
 * Throws on an unparseable bucket `file_size_limit`, mapped by the caller to a config-load
 * error. `storageFileSizeLimitBytes` must already be parsed.
 */
export function resolveBucketProps(opts: {
  readonly document: Record<string, unknown> | undefined;
  readonly name: string;
  readonly bucket: BucketConfigEntry;
  readonly storageFileSizeLimitBytes: number;
}): UpsertBucketProps {
  const bucketBytes = bucketHasKey(opts.document, opts.name, "file_size_limit")
    ? parseFileSizeLimit(opts.bucket.file_size_limit)
    : 0;
  const fileSizeLimit = bucketBytes === 0 ? opts.storageFileSizeLimitBytes : bucketBytes;
  return {
    public: bucketHasKey(opts.document, opts.name, "public") ? opts.bucket.public : undefined,
    fileSizeLimit,
    allowedMimeTypes: opts.bucket.allowed_mime_types,
  };
}
