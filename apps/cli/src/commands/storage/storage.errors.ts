import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { aqua } from "../../command-internal/colors.ts";
import { goQuote } from "../../command-internal/go-quote.ts";

/**
 * Domain errors for `supabase storage ls/cp/mv/rm`. Each `message` is an
 * established stderr text.
 *
 * Storage gateway errors and credential-derivation errors live in
 * `command-internal/storage-gateway.errors.ts` and
 * `command-internal/storage-credentials.errors.ts`; url-parse failures come from
 * `command-internal/storage-url.ts` and are mapped here.
 */

export class StorageInvalidUrlError extends Data.TaggedError("StorageInvalidUrlError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "URL must match pattern ss:///bucket/[prefix]" });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `message` already contains the full `failed to parse storage url: parse "…": …` text. */
export class StorageUrlParseError extends Data.TaggedError("StorageUrlParseError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Local→local copy is unsupported; `suggestion` renders as an aqua hint after the error. */
export class StorageUnsupportedOperationError extends Data.TaggedError(
  "StorageUnsupportedOperationError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  constructor() {
    super({
      message: "Unsupported operation",
      suggestion: `Run ${aqua("cp -r <src> <dst>")} to copy between local directories.`,
    });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Formats an invalid `-j, --jobs` value using the established
 * `invalid argument %q for %q flag: %v` message, with the raw (unnormalized) token
 * quoted and escaped so it never breaks onto a new line.
 */
export function storageInvalidJobsMessage(token: string, cause: string): string {
  const quoted = goQuote(new TextEncoder().encode(token));
  return `invalid argument ${quoted} for "-j, --jobs" flag: strconv.ParseUint: parsing ${quoted}: ${cause}`;
}

export class StorageCopyBetweenBucketsError extends Data.TaggedError(
  "StorageCopyBetweenBucketsError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "Copying between buckets is not supported" });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class StorageUnsupportedMoveError extends Data.TaggedError("StorageUnsupportedMoveError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "Moving between buckets is unsupported" });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class StorageMissingPathError extends Data.TaggedError("StorageMissingPathError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "You must specify an object path" });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class StorageMissingBucketError extends Data.TaggedError("StorageMissingBucketError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "You must specify a bucket to delete." });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class StorageMissingFlagError extends Data.TaggedError("StorageMissingFlagError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "You must specify -r flag to delete directories." });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Raised by recursive `cp`/`mv`/`rm` when no objects match the given path. */
export class StorageObjectNotFoundError extends Data.TaggedError("StorageObjectNotFoundError")<{
  readonly message: string;
}> {
  constructor(path: string) {
    super({ message: `Object not found: ${path}` });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** Raised with an established "failed to read file: …" or "failed to create file: …" message. */
export class StorageFileError extends Data.TaggedError("StorageFileError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/** Conflicting target flags: `--linked` with `--local`, or `--project-ref` with `--local`. */
export class StorageMutuallyExclusiveFlagsError extends Data.TaggedError(
  "StorageMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory (`validateWorkdirIsDirectory`). Only reachable when the
 * user explicitly set it — beats every other guard in `ls`/`mv`/`rm`/`cp`.
 */
export class StorageWorkdirError extends Data.TaggedError("StorageWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` holds no project config —
 * raised instead of silently falling back to the embedded default config,
 * whose default `api.port` could otherwise point the operation at a
 * different, possibly running, local stack.
 */
export class StorageMissingProjectConfigError extends Data.TaggedError(
  "StorageMissingProjectConfigError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
