import { ramInBytes } from "./legacy-size-units.ts";
import type { LegacyUpsertBucketProps } from "./legacy-storage-gateway.ts";

/**
 * Pure helpers that turn a `[storage.buckets.*]` config entry into the
 * create/update bucket props the Storage gateway sends. Shared by `seed buckets`
 * (which seeds every configured bucket) and `storage cp` (which auto-creates a
 * bucket on a `Bucket not found` upload, reading the same config —
 * `internal/storage/cp/cp.go:154-160`). Kept free of Effect/services so the
 * Go-parity rules (size parsing, storage-level inheritance, `public` tri-state)
 * stay unit-testable.
 */

/**
 * Parse a `file_size_limit` config string (e.g. `"50MiB"`) to the int64 byte
 * count Go sends in the create/update bucket body (`int64(bucket.FileSizeLimit)`,
 * `pkg/storage/batch.go:38/49`). `@supabase/config` keeps the field as the raw
 * human-readable string, so the conversion Go performs at config-load happens
 * here. Throws on an unparseable value (Go aborts config load), which the caller
 * maps to a config-load error.
 */
export function legacyParseFileSizeLimit(sizeStr: string): number {
  return ramInBytes(sizeStr);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the bucket's TOML entry explicitly declares `key`. Go reads `public`
 * into a `*bool` and `file_size_limit` into a pointer, so an absent key is
 * omitted (not the decoded schema default), and that "omitted" signal drives the
 * `public` tri-state and the storage-level `file_size_limit` inheritance.
 * `@supabase/config` loses it (decodes to the schema default), so recover
 * presence from the raw (post-`env()`) document.
 */
export function legacyBucketHasKey(
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

interface LegacyBucketConfigEntry {
  readonly public: boolean;
  readonly file_size_limit: string;
  readonly allowed_mime_types: ReadonlyArray<string>;
}

/**
 * Resolve a bucket's create/update props, mirroring Go's `config.resolve()`
 * (`pkg/config/config.go:753-756`) + the `sizeInBytes` decode at config-load:
 *  - an omitted or zero `file_size_limit` inherits the (already-parsed)
 *    storage-level limit;
 *  - `public` is the explicit value only when the TOML declares it, else
 *    `undefined` (Go's `*bool` nil → omitted from the request body).
 *
 * Throws on an unparseable bucket `file_size_limit` (the caller maps it to a
 * config-load error). `storageFileSizeLimitBytes` must already be parsed.
 */
export function legacyResolveBucketProps(opts: {
  readonly document: Record<string, unknown> | undefined;
  readonly name: string;
  readonly bucket: LegacyBucketConfigEntry;
  readonly storageFileSizeLimitBytes: number;
}): LegacyUpsertBucketProps {
  const bucketBytes = legacyBucketHasKey(opts.document, opts.name, "file_size_limit")
    ? legacyParseFileSizeLimit(opts.bucket.file_size_limit)
    : 0;
  const fileSizeLimit = bucketBytes === 0 ? opts.storageFileSizeLimitBytes : bucketBytes;
  return {
    public: legacyBucketHasKey(opts.document, opts.name, "public") ? opts.bucket.public : undefined,
    fileSizeLimit,
    allowedMimeTypes: opts.bucket.allowed_mime_types,
  };
}
