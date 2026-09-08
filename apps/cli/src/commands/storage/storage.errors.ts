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
 * The Storage gateway errors (`StorageGateway{Network,Status}Error`) and
 * credential-derivation errors live in the shared modules
 * `command-internal/storage-gateway.errors.ts` and
 * `command-internal/storage-credentials.errors.ts`; the url-parse failures
 * are thrown by `command-internal/storage-url.ts` and mapped here.
 */

/** `client.ErrInvalidURL` (`internal/storage/client/scheme.go:12`). */
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

/**
 * A `url.Parse` failure, wrapped like Go's
 * `errors.Errorf("failed to parse … url: %w", err)`. The `message` already
 * contains the full `failed to parse storage url: parse "…": …` text.
 */
export class StorageUrlParseError extends Data.TaggedError("StorageUrlParseError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `cp`'s local→local branch (`internal/storage/cp/cp.go:59-60`). Go sets
 * `utils.CmdSuggestion` to the aqua `cp -r` hint, printed verbatim after the
 * error — the legacy text error renderer prints `suggestion` the same way.
 */
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
 * `cp`'s `--jobs` is a pflag uint: a non-uint token fails
 * `strconv.ParseUint(s, 0, 64)` at flag-parse time. Established message
 * format `invalid argument %q for %q flag: %v` with the shorthand-prefixed
 * flag name, carrying the RAW token (so `--jobs=-01` reports `"-01"`, not a
 * normalized `"-1"`) and strconv's cause (`invalid syntax` / `value out of
 * range`). Both token occurrences are `%q`-quoted — pflag applies `%q` to
 * the value and strconv's `NumError.Error()` wraps `e.Num` in
 * `strconv.Quote` — so an escapable token stays one escaped line (go1.26:
 * `--jobs 'a"b'` → `… "a\"b" …`, not a raw quote/newline).
 * Thrown from the flag's own `Flag.mapTryCatch` in `cp.command.ts` so the
 * rejection happens during command parsing — `formatInvalidValueMessage`
 * surfaces the resulting `CliError.InvalidValue`'s message verbatim.
 */
export function storageInvalidJobsMessage(token: string, cause: string): string {
  const quoted = goQuote(new TextEncoder().encode(token));
  return `invalid argument ${quoted} for "-j, --jobs" flag: strconv.ParseUint: parsing ${quoted}: ${cause}`;
}

/** `cp`'s remote→remote branch (`internal/storage/cp/cp.go:57`). */
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

/** `mv`'s cross-bucket branch (`internal/storage/mv/mv.go:19,38`). */
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

/** `mv`'s both-root branch (`internal/storage/mv/mv.go:20,35`). */
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

/** `rm`'s root-arg branch (`internal/storage/rm/rm.go:21,41`). */
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

/** `rm`'s directory-without-`-r` branch (`internal/storage/rm/rm.go:22,44,53`). */
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

/**
 * `Object not found: <path>` — `cp` recursive download with no objects
 * (`cp.go:94`), `mv` recursive with no objects (`mv.go:85`), `rm` recursive on
 * an empty prefix (`rm.go:114`).
 */
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

/** `failed to read file:` / `failed to create file:` (`pkg/storage/objects.go`). */
export class StorageFileError extends Data.TaggedError("StorageFileError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Both `--linked` and `--local` set — mutually exclusive.
 */
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
