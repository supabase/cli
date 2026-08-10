import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { legacyAqua } from "../../shared/legacy-colors.ts";
import { legacyGoQuote } from "../../shared/legacy-go-quote.ts";

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

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A `url.Parse` failure, wrapped like Go's
 * `errors.Errorf("failed to parse … url: %w", err)`. The `message` already
 * contains the full `failed to parse storage url: parse "…": …` text.
 */
export class LegacyStorageUrlParseError extends Data.TaggedError("LegacyStorageUrlParseError")<{
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

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `cp`'s `--jobs` is a pflag uint (`UintVarP`, `cmd/storage.go:107`): a
 * non-uint token fails `strconv.ParseUint(s, 0, 64)` at flag-parse time.
 * Byte-matches pflag's `invalid argument %q for %q flag: %v` template with
 * the shorthand-prefixed flag name (`pflag/errors.go:108-116`), carrying the
 * RAW token (so `--jobs=-01` reports `"-01"`, not a normalized `"-1"`) and
 * strconv's cause (`invalid syntax` / `value out of range`). Both token
 * occurrences are `%q`-quoted like Go's — pflag applies `%q` to the value
 * and strconv's `NumError.Error()` wraps `e.Num` in `strconv.Quote`
 * (`strconv/number.go:258-260`) — so an escapable token stays one escaped
 * line (go1.26: `--jobs 'a"b'` → `… "a\"b" …`, not a raw quote/newline).
 * Thrown from the flag's own `Flag.mapTryCatch` in `cp.command.ts` so the
 * rejection happens during command parsing, like Go's —
 * `formatInvalidValueMessage` surfaces the resulting
 * `CliError.InvalidValue`'s message verbatim.
 */
export function legacyStorageInvalidJobsMessage(token: string, cause: string): string {
  const quoted = legacyGoQuote(new TextEncoder().encode(token));
  return `invalid argument ${quoted} for "-j, --jobs" flag: strconv.ParseUint: parsing ${quoted}: ${cause}`;
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

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
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

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
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

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
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

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
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

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
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

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** `failed to read file:` / `failed to create file:` (`pkg/storage/objects.go`). */
export class LegacyStorageFileError extends Data.TaggedError("LegacyStorageFileError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Both `--linked` and `--local` set, reproducing cobra's
 * `MarkFlagsMutuallyExclusive("linked", "local")` (`apps/cli-go/cmd/storage.go:99`).
 */
export class LegacyStorageMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyStorageMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
