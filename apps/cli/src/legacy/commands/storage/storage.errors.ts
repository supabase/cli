import { Data } from "effect";

import { legacyAqua } from "../../shared/legacy-colors.ts";

/**
 * Domain errors for `supabase storage ls/cp/mv/rm`, mirroring the Go error paths
 * in `internal/storage/{client,ls,cp,mv,rm}`. Each `message` byte-matches the Go
 * CLI's stderr text.
 *
 * The Storage gateway errors (`LegacyStorageGateway{Network,Status}Error`) and
 * credential-derivation errors live in the shared modules
 * `legacy/shared/legacy-storage-gateway.errors.ts` and
 * `legacy/shared/legacy-storage-credentials.errors.ts`; the url-parse failures
 * are thrown by `legacy/shared/legacy-storage-url.ts` and mapped here.
 */

/** `client.ErrInvalidURL` (`internal/storage/client/scheme.go:12`). */
export class LegacyStorageInvalidUrlError extends Data.TaggedError("LegacyStorageInvalidUrlError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "URL must match pattern ss:///bucket/[prefix]" });
  }
}

/**
 * A `url.Parse` failure, wrapped like Go's
 * `errors.Errorf("failed to parse … url: %w", err)`. The `message` already
 * contains the full `failed to parse storage url: parse "…": …` text.
 */
export class LegacyStorageUrlParseError extends Data.TaggedError("LegacyStorageUrlParseError")<{
  readonly message: string;
}> {}

/**
 * `cp`'s local→local branch (`internal/storage/cp/cp.go:59-60`). Go sets
 * `utils.CmdSuggestion` to the aqua `cp -r` hint, printed verbatim after the
 * error — the legacy text error renderer prints `suggestion` the same way.
 */
export class LegacyStorageUnsupportedOperationError extends Data.TaggedError(
  "LegacyStorageUnsupportedOperationError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  constructor() {
    super({
      message: "Unsupported operation",
      suggestion: `Run ${legacyAqua("cp -r <src> <dst>")} to copy between local directories.`,
    });
  }
}

/** `cp`'s remote→remote branch (`internal/storage/cp/cp.go:57`). */
export class LegacyStorageCopyBetweenBucketsError extends Data.TaggedError(
  "LegacyStorageCopyBetweenBucketsError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "Copying between buckets is not supported" });
  }
}

/** `mv`'s cross-bucket branch (`internal/storage/mv/mv.go:19,38`). */
export class LegacyStorageUnsupportedMoveError extends Data.TaggedError(
  "LegacyStorageUnsupportedMoveError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "Moving between buckets is unsupported" });
  }
}

/** `mv`'s both-root branch (`internal/storage/mv/mv.go:20,35`). */
export class LegacyStorageMissingPathError extends Data.TaggedError(
  "LegacyStorageMissingPathError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "You must specify an object path" });
  }
}

/** `rm`'s root-arg branch (`internal/storage/rm/rm.go:21,41`). */
export class LegacyStorageMissingBucketError extends Data.TaggedError(
  "LegacyStorageMissingBucketError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "You must specify a bucket to delete." });
  }
}

/** `rm`'s directory-without-`-r` branch (`internal/storage/rm/rm.go:22,44,53`). */
export class LegacyStorageMissingFlagError extends Data.TaggedError(
  "LegacyStorageMissingFlagError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "You must specify -r flag to delete directories." });
  }
}

/**
 * `Object not found: <path>` — `cp` recursive download with no objects
 * (`cp.go:94`), `mv` recursive with no objects (`mv.go:85`), `rm` recursive on
 * an empty prefix (`rm.go:114`).
 */
export class LegacyStorageObjectNotFoundError extends Data.TaggedError(
  "LegacyStorageObjectNotFoundError",
)<{
  readonly message: string;
}> {
  constructor(path: string) {
    super({ message: `Object not found: ${path}` });
  }
}

/** `failed to read file:` / `failed to create file:` (`pkg/storage/objects.go`). */
export class LegacyStorageFileError extends Data.TaggedError("LegacyStorageFileError")<{
  readonly message: string;
}> {}

/**
 * Both `--linked` and `--local` set, reproducing cobra's
 * `MarkFlagsMutuallyExclusive("linked", "local")` (`apps/cli-go/cmd/storage.go:99`).
 */
export class LegacyStorageMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyStorageMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {}
