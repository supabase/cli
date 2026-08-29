import { Data, Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { legacyBold } from "./legacy-colors.ts";
import { LegacyDbConnectError, LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import type { LegacyDbBatchStatement, LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyErrorMessage, legacyRelativizeErrorMessage } from "./legacy-error-message.ts";
import {
  INSERT_MIGRATION_VERSION,
  MIGRATE_FILE_PATTERN,
  legacyCreateMigrationTable,
  legacySortMigrationPathsByVersion,
} from "./legacy-migration-history.ts";
import { legacyParseMigrationContent } from "./legacy-migration-file.ts";
import { legacySqlFilesGlob } from "./legacy-sql-files-glob.ts";
import { legacySplitSqlTokens } from "./legacy-sql-split.ts";

/**
 * Applying a migration file failed (`ApplyMigrations` / `ExecBatch` error).
 * Used by `migration up` and `migration down`'s migrate-and-seed step. The
 * declarative sync handler maps its own error type instead.
 *
 * `suggestion` carries caller remediation. This includes schema-file guidance
 * from `legacyApplySchemaFiles` and the local-only pg_net/webhooks remediation added
 * when start/reset replay has enough structured context to identify that failure.
 */
export class LegacyMigrationApplyError extends Data.TaggedError("LegacyMigrationApplyError")<{
  readonly message: string;
  readonly suggestion?: string;
  readonly reason?: "local_pg_net_unavailable";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.reason === "local_pg_net_unavailable"
      ? actionability.invalidConfig
      : actionability.dbFinding;
  }
}

// Byte order mark (U+FEFF) — stripped from the head of a statement like Go does.
const BOM_CODE_POINT = 0xfeff;

// Statements that PostgreSQL refuses to run inside a transaction block / extended-query
// pipeline (SQLSTATE 25001). Matched against the upper-cased, comment-stripped statement.
//
// Provenance (CLI-1989): the design for this behaviour is the fix proposed for
// supabase/cli#5139 in PR supabase/cli#5156 (`isPipelineIncompatible` /
// `trimLeadingSQLComments`). That PR was closed WITHOUT merging — its design was adopted
// directly into this TS apply instead in PR supabase/cli#5671 (squash-merged to develop
// as b48fad60; the #5156 closing comment cites the PR-branch commit 29d3fb0e).
//
// Known residual delta: JS `\s` matches `\v` (vertical tab), but Go RE2 `\s` is
// `[\t\n\f\r ]` and does not. PostgreSQL >= 14 treats `\v` as SQL whitespace, so a
// statement separated only by `\v` (e.g. `VACUUM\v(FULL)`) classifies as
// pipeline-incompatible here but wouldn't under that narrower definition. Not worth
// changing behaviour over — flagging so a future review doesn't rediscover it.
const CREATE_INDEX_CONCURRENTLY_PATTERN = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY(?:\s|$)/u;
const DROP_INDEX_CONCURRENTLY_PATTERN = /^DROP\s+INDEX\s+CONCURRENTLY(?:\s|$)/u;
const REINDEX_CONCURRENTLY_PATTERN = /^REINDEX(?:\s|\().*\sCONCURRENTLY(?:\s|$)/u;
const VACUUM_PATTERN = /^VACUUM(?:\s|\(|$)/u;
const ALTER_SYSTEM_PATTERN = /^ALTER\s+SYSTEM(?:\s|$)/u;
const CLUSTER_PATTERN = /^CLUSTER(?:\s|$)/u;
const DATABASE_DDL_PATTERN = /^(?:CREATE|DROP)\s+DATABASE(?:\s|$)/u;
const TABLESPACE_DDL_PATTERN = /^(?:CREATE|DROP)\s+TABLESPACE(?:\s|$)/u;
const REINDEX_DATABASE_PATTERN = /^REINDEX(?:\s+\([^)]*\))?\s+(?:DATABASE|SYSTEM|SCHEMA)(?:\s|$)/u;
const SUBSCRIPTION_DDL_PATTERN = /^(?:CREATE|DROP)\s+SUBSCRIPTION(?:\s|$)/u;
const DISCARD_ALL_PATTERN = /^DISCARD\s+ALL(?:\s|$)/u;
const ALTER_DATABASE_TABLESPACE_PATTERN =
  /^ALTER\s+DATABASE\s+(?:"[^"]*"|\S+)\s+SET\s+TABLESPACE(?:\s|$)/u;
const ALTER_SUBSCRIPTION_REFRESH_PATTERN =
  /^ALTER\s+SUBSCRIPTION\s+(?:"[^"]*"|\S+)\s+(?:REFRESH\s+PUBLICATION|(?:SET|ADD|DROP)\s+PUBLICATION)(?:\s|$)/u;
const DETACH_PARTITION_PATTERN =
  /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"[^"]*"|\S+)\s+DETACH\s+PARTITION\s+(?:"[^"]*"|\S+)\s+(?:CONCURRENTLY|FINALIZE)(?:\s|$)/u;
const TRANSACTION_CONTROL_PATTERN =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|PREPARE\s+TRANSACTION)(?:\s|$)/u;

/**
 * Strips a leading BOM, whitespace, and SQL line (`--`) and block comments from the
 * front of a statement so the keyword check below sees the real first token.
 * Port of `trimLeadingSQLComments` (`pkg/migration/file.go`, supabase/cli#5156).
 */
const legacyTrimLeadingSqlComments = (sql: string): string => {
  // `TrimLeftFunc` drops a leading BOM together with whitespace; strip the BOM
  // via its code point so no irregular whitespace lands in the source.
  let trimmed = sql.replace(/^[ \t\n\r]+/u, "");
  while (trimmed.charCodeAt(0) === BOM_CODE_POINT) {
    trimmed = trimmed.slice(1).replace(/^[ \t\n\r]+/u, "");
  }
  for (;;) {
    if (trimmed.startsWith("--")) {
      const idx = trimmed.indexOf("\n");
      if (idx < 0) return "";
      trimmed = trimmed.slice(idx + 1).replace(/^[ \t\n\r]+/u, "");
    } else if (trimmed.startsWith("/*")) {
      const idx = trimmed.indexOf("*/");
      if (idx < 0) return trimmed;
      trimmed = trimmed.slice(idx + 2).replace(/^[ \t\n\r]+/u, "");
    } else {
      return trimmed.trim();
    }
  }
};

/**
 * Whether a migration statement cannot run inside a transaction block — `CREATE
 * [UNIQUE] INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`,
 * `VACUUM`, `ALTER SYSTEM`, `CLUSTER`, `CREATE`/`DROP DATABASE`,
 * `CREATE`/`DROP TABLESPACE`, `REINDEX DATABASE`/`SYSTEM`/`SCHEMA`,
 * `CREATE`/`DROP SUBSCRIPTION`, `DISCARD ALL`,
 * `ALTER DATABASE … SET TABLESPACE`,
 * `ALTER SUBSCRIPTION … REFRESH`/`SET`/`ADD`/`DROP PUBLICATION`,
 * `ALTER TABLE … DETACH PARTITION … CONCURRENTLY`/`FINALIZE`. Such statements fail with
 * SQLSTATE 25001 inside the transaction
 * created by a migration batch, so `execMigrationBatch` runs them standalone.
 * Port of `isPipelineIncompatible` (`pkg/migration/file.go`, supabase/cli#5156),
 * extended with the remaining statement kinds PostgreSQL refuses inside the
 * explicit transaction the batch runs in since supabase/cli#6347.
 */
export const legacyIsPipelineIncompatible = (sql: string): boolean => {
  const upper = legacyTrimLeadingSqlComments(sql).toUpperCase();
  return (
    CREATE_INDEX_CONCURRENTLY_PATTERN.test(upper) ||
    DROP_INDEX_CONCURRENTLY_PATTERN.test(upper) ||
    REINDEX_CONCURRENTLY_PATTERN.test(upper) ||
    VACUUM_PATTERN.test(upper) ||
    ALTER_SYSTEM_PATTERN.test(upper) ||
    CLUSTER_PATTERN.test(upper) ||
    DATABASE_DDL_PATTERN.test(upper) ||
    TABLESPACE_DDL_PATTERN.test(upper) ||
    REINDEX_DATABASE_PATTERN.test(upper) ||
    SUBSCRIPTION_DDL_PATTERN.test(upper) ||
    DISCARD_ALL_PATTERN.test(upper) ||
    ALTER_DATABASE_TABLESPACE_PATTERN.test(upper) ||
    ALTER_SUBSCRIPTION_REFRESH_PATTERN.test(upper) ||
    DETACH_PARTITION_PATTERN.test(upper)
  );
};

/** Whether the statement owns a transaction boundary that must not be nested. */
export const legacyHasTransactionControl = (sql: string): boolean => {
  const upper = legacyTrimLeadingSqlComments(sql).toUpperCase();
  const words = upper.split(/\s+/u);
  if (words[0] === "ROLLBACK") {
    const toIndex = words[1] === "WORK" || words[1] === "TRANSACTION" ? 2 : 1;
    // ROLLBACK [WORK | TRANSACTION] TO [SAVEPOINT] rewinds the current
    // transaction without ending it, so it still needs the CLI-managed wrapper.
    return words[toIndex] !== "TO";
  }
  return TRANSACTION_CONTROL_PATTERN.test(upper);
};

const ROLE_REVERT_PATTERN =
  /^(?:RESET\s+ROLE|RESET\s+SESSION\s+AUTHORIZATION|SET\s+(?:SESSION\s+)?ROLE(?:\s+TO\s+|\s*=\s*|\s+)(?:NONE|DEFAULT)|SET\s+SESSION\s+AUTHORIZATION\s+DEFAULT|DISCARD\s+ALL)(?:\s|;|$)/u;

// PostgreSQL's `check_role` compares the quoted value case-sensitively against
// "none", so the quoted spellings are matched before the uppercase fold —
// `SET ROLE "NONE"` selects a real role named `NONE`, never a reset.
const QUOTED_ROLE_VALUE_PATTERN =
  /^SET\s+(?:SESSION\s+)?ROLE(?:\s+TO\s+|\s*=\s*|\s+)(['"])(.*?)\1(?:\s|;|$)/iu;

/**
 * Whether a top-level statement reverts a stepped-down session to its login role
 * (`RESET ROLE`, the generic-`SET` spellings of `role`'s reset, `RESET SESSION
 * AUTHORIZATION` and friends, `DISCARD ALL`). File runners re-assert `postgres`
 * right after each match, so the rest of the file keeps `current_user = postgres`
 * as on a password session (supabase/cli#6236); reverts a lexical check cannot
 * see (dynamic SQL, `SET LOCAL ROLE NONE` — deliberately unmatched, since a
 * session-scoped restore would override its transaction scope) are backstopped
 * by the trailing restore before any CLI-owned write. `RESET ALL` is
 * deliberately absent — `role` carries `GUC_NO_RESET_ALL`.
 */
export const legacyRevertsToLoginRole = (sql: string): boolean => {
  const trimmed = legacyTrimLeadingSqlComments(sql);
  return (
    ROLE_REVERT_PATTERN.test(trimmed.toUpperCase()) ||
    QUOTED_ROLE_VALUE_PATTERN.exec(trimmed)?.[2] === "none"
  );
};

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

// `startBufSize` — the fixed initial scanner
// buffer size pre-allocated before applying the configured/default max. The
// scanner's buffer therefore starts at exactly this size regardless of how small
// `SUPABASE_SCANNER_BUFFER_SIZE` is set, and the too-long check only fires once
// the buffer is full — so a statement must reach at least this many raw bytes
// before an oversized-token error can ever be raised, no matter how small the override.
// Verified empirically: a
// single-statement probe of exactly 4096 raw bytes always succeeds — even with
// `SUPABASE_SCANNER_BUFFER_SIZE` set to 10 bytes — while 4097 bytes always fails;
// with the override set above this floor (e.g. 5000 bytes), the exact same
// pattern repeats at the override's own value (5000 succeeds, 5001 fails).
const GO_SCANNER_START_BUF_SIZE = 4096;

// The hardcoded default scanner capacity
// fallen back to when `viper.GetSizeInBytes("SCANNER_BUFFER_SIZE")`
// returns `0`. Reached whenever the env var is SET but resolves to a non-positive size —
// including a value `legacyParseScannerBufferSize` can't parse at all. Verified
// empirically:
// `SUPABASE_SCANNER_BUFFER_SIZE=5M` (a bare multiplier suffix with NO trailing `b`/`B`)
// behaves byte-for-byte identically to the var being completely unset from the default
// cap's own first-failure point on — because `parseSizeInBytes` only ever recognizes a
// `k`/`m`/`g` multiplier when it immediately precedes a trailing `b`/`B`;
// "5M" never strips a suffix, so it falls through to
// `cast.ToInt("5M")`, which fails whole (not a leading-digits prefix parse — unlike
// JS's lenient `Number.parseInt`) and returns `0`. This is NOT the same as truly unset,
// though: `viper.IsSet("SCANNER_BUFFER_SIZE")` is still `true` (the var IS present, just
// unparseable), so `parseFile`'s file-size auto-growth (see `checkScannerBufferSize`'s
// doc comment) never runs — the cap stays pinned at this hardcoded default regardless of
// the real file's size, unlike the genuinely-unset case where it grows to match.
const GO_DEFAULT_MAX_SCANNER_CAPACITY = 256 * 1024;

/**
 * `viper.GetSizeInBytes("SCANNER_BUFFER_SIZE")` (env-prefixed
 * `SUPABASE_SCANNER_BUFFER_SIZE`): an integer byte count,
 * optionally suffixed `k`/`K`/`m`/`M`/`g`/`G` (× 1024/1024²/1024³) plus a trailing
 * `b`/`B` (e.g. `"5MB"`, `"256KB"`, or a bare byte count). Ported 1:1 from viper's
 * own parser (`parseSizeInBytes`):
 * an unparseable or non-positive result is treated as unset (`0`).
 *
 * The multiplier is recognized ONLY when the string's LAST character is literally
 * `b`/`B` — a bare `"5M"` (no trailing `B`) is NOT 5 MiB in real Go: `sizeStr[lastChar]`
 * isn't `b`/`B`, so the multiplier branch never runs and the whole (unstripped) string
 * is handed to `cast.ToInt`, which fails on the trailing letter and yields `0`. Do NOT
 * special-case a bare `k`/`m`/`g` suffix here; that would make this port accept a value
 * real Go rejects.
 *
 * Go's inner `lastChar > 1` gate means the trailing-`B`-strip ALSO never
 * runs for a 2-character value like `"5B"`/`"5b"` — only 3+ characters (an actual
 * multiplier letter, or at least one digit, before the `B`) reach the switch at all — so
 * `"5B"` is unstripped, `cast.ToInt("5B")` fails, and the whole thing is `0` too, same as
 * `"5M"`. `cast.ToInt` (`strconv.ParseInt`) also requires the ENTIRE remaining string to
 * be a clean integer — trailing garbage fails the WHOLE parse, unlike JS's lenient
 * `Number.parseInt`, which stops at the first non-digit and returns whatever numeric
 * prefix it found (`Number.parseInt("5M", 10) === 5`, silently discarding the "M", where
 * Go's parse rejects the string outright). `cast.ToInt` does tolerate one decimal point
 * via its own `trimDecimal` (keeps only the integer part, e.g. `"5.5"` → `"5"`), so allow
 * exactly that one exception. All of the above verified empirically
 * (`"5"→5, "5B"→0, "50B"→50, "5KB"→5120, "5M"→0, "0"→0, "5.5"→5, "5.5MB"→5242880`).
 *
 * `cast.ToInt`'s underlying `strconv.ParseInt(s, 0, 0)` (review CLI-1958) uses base
 * `0`, so the remaining (post multiplier-strip) string is ALSO accepted as a
 * `0x`/`0X`-prefixed hex literal, an `0o`/`0O`-prefixed OR bare-leading-zero octal
 * literal, or a `0b`/`0B`-prefixed binary literal — handled below by
 * {@link parseGoBaseZeroInt}. Verified empirically
 * (via `viper.GetSizeInBytes`, since `cast.ToInt` is itself unexported call
 * plumbing): `"0x100000"→1048576`, `"0o40000"→16384`,
 * `"0b100000000000000000000"→2097152`, `"0755"` (legacy octal, no `"o"`)`→493`,
 * `"0x"/"garbage"/"0x1g"→unparseable (0)`. A hex/octal/binary value ending in a
 * literal `b`/`B` digit (e.g. `"0x1B"`) still hits the multiplier-strip switch
 * ABOVE first, same as any other value — that consumes the trailing `B` before
 * base-0 parsing ever sees it (`"0x1B"→1`, not `27`), which is a genuine Go quirk
 * this port reproduces automatically by keeping the same two-step order, not a bug.
 * Go's base-0 grammar also permits `_` digit separators (e.g. `"1_048_576"`) — see
 * {@link parseGoBaseZeroInt}'s own doc comment for the exact placement grammar.
 */
/**
 * Go's underscore digit-separator grammar (`go.dev/ref/spec#Integer_literals`,
 * reproduced by `strconv.ParseInt`'s base-0 mode, review CLI-1958): a SINGLE `_`
 * may sit immediately after a base prefix (explicit `0x`/`0o`/`0b`, or the bare
 * leading `"0"` of legacy octal) or between two digits of the same base — never
 * doubled, never leading a plain (no-prefix) decimal literal, and never trailing.
 * Verified empirically against the real `strconv.ParseInt(s, 0, 64)`:
 * `"1_048_576"→1048576`, `"0x_100000"/"0x10_0000"→1048576`,
 * `"0o_40000"/"0o4_0000"→16384`, `"0b_100000000000000000000"→1048576`,
 * `"0_755"/"07_55"→493` (legacy octal, underscore right after the leading `"0"`
 * or between later octal digits); while `"_1048576"`, `"1048576_"`,
 * `"1__048576"`, `"0x100000_"`, and `"0_x100000"` (underscore splitting the
 * leading `"0"` from the `"x"` — not a real prefix, so it's parsed as legacy
 * octal digits `"x100000"`) all fail.
 */
// `strconv.ParseInt(s, 0, 0)`'s bitSize-0 mode requires the result to fit in `int` —
// 64 bits on every platform this CLI ships for (amd64/arm64). A magnitude outside
// this range is a range error, and `cast.ToInt` discards ANY parse error — range or
// syntax — and returns exactly `0`, not the (possibly huge, saturated-to-max-magnitude)
// value `strconv.ParseInt` itself returns alongside that error. Verified empirically:
// `cast.ToInt("9223372036854775808")` (one over
// `math.MaxInt64`) → `0`. `Number.parseInt` has no such range check (it silently rounds
// via IEEE-754 double precision instead), so this must reject the same magnitudes,
// or it would treat an out-of-range override as an enormous-but-finite limit
// instead of falling back to the 256KiB default (review CLI-1958 round 18).
const GO_MAX_INT64 = 9223372036854775807n;
const GO_MIN_INT64 = -9223372036854775808n;

const parseGoBaseZeroInt = (value: string): number | undefined => {
  const negative = value.startsWith("-");
  const unsigned = negative || value.startsWith("+") ? value.slice(1) : value;
  if (unsigned.length === 0) return undefined;

  let base = 10;
  let digits = unsigned;
  const prefix = unsigned.slice(0, 2).toLowerCase();
  if (prefix === "0x") {
    base = 16;
    digits = unsigned.slice(2);
  } else if (prefix === "0o") {
    base = 8;
    digits = unsigned.slice(2);
  } else if (prefix === "0b") {
    base = 2;
    digits = unsigned.slice(2);
  } else if (unsigned.length > 1 && unsigned[0] === "0") {
    // Legacy (no "o") leading-zero octal, e.g. "0755".
    base = 8;
    digits = unsigned.slice(1);
  }
  if (digits.length === 0) return undefined;

  // Only a real base prefix (or the legacy-octal leading "0") may be followed
  // immediately by an underscore; a plain decimal literal has no prefix to
  // follow, so a leading underscore there is always invalid (matches Go).
  const hadPrefix = base !== 10;
  const digitClass = base === 16 ? "0-9a-fA-F" : base === 8 ? "0-7" : base === 2 ? "01" : "0-9";
  const validPattern = new RegExp(
    `^${hadPrefix ? "_?" : ""}[${digitClass}](?:_?[${digitClass}])*$`,
  );
  if (!validPattern.test(digits)) return undefined;

  const cleanDigits = digits.replace(/_/g, "");
  // Exact-magnitude range check via BigInt — `Number.parseInt` below loses precision
  // past 2^53 and never errors, so the int64 bound must be checked independently of it.
  const bigPrefix = base === 16 ? "0x" : base === 8 ? "0o" : base === 2 ? "0b" : "";
  const magnitude = BigInt(`${bigPrefix}${cleanDigits}`);
  const signedMagnitude = negative ? -magnitude : magnitude;
  if (signedMagnitude > GO_MAX_INT64 || signedMagnitude < GO_MIN_INT64) return undefined;

  const n = Number.parseInt(cleanDigits, base);
  return negative ? -n : n;
};

// `cast.ToInt`'s `trimDecimal` runs BEFORE
// `strconv.ParseInt`: when the whole string is a sign + plain decimal digits + an
// optional ".digits" tail (`stringNumberRe`, `^([-+]?\d*)(\.\d*)?$` — never matches
// a `0x`/`0o`/`0b` literal, which contains letters), it drops the fractional part
// outright rather than rounding (`"5.5"` → `"5"`). Anything else (including a
// non-decimal-looking string that merely contains a ".") passes through unchanged
// and is left for {@link parseGoBaseZeroInt} to accept or reject.
const trimGoDecimal = (value: string): string => {
  if (!value.includes(".")) return value;
  const match = /^([+-]?\d*)(?:\.\d*)?$/.exec(value);
  if (!match) return value;
  const intPart = match[1] ?? "";
  if (intPart === "+" || intPart === "-") return `${intPart}0`;
  return intPart === "" ? "0" : intPart;
};

const legacyParseScannerBufferSize = (raw: string): number => {
  let value = raw.trim();
  let multiplier = 1;
  const lastIndex = value.length - 1;
  if (lastIndex > 1 && (value[lastIndex] === "b" || value[lastIndex] === "B")) {
    switch (value[lastIndex - 1]!.toLowerCase()) {
      case "k":
        multiplier = 1 << 10;
        value = value.slice(0, lastIndex - 1).trim();
        break;
      case "m":
        multiplier = 1 << 20;
        value = value.slice(0, lastIndex - 1).trim();
        break;
      case "g":
        multiplier = 1 << 30;
        value = value.slice(0, lastIndex - 1).trim();
        break;
      default:
        value = value.slice(0, lastIndex).trim();
        break;
    }
  }
  const size = parseGoBaseZeroInt(trimGoDecimal(value));
  return size !== undefined && Number.isFinite(size) && size > 0 ? size * multiplier : 0;
};

/**
 * `parser.Split`/`SplitAndTrim` enforces
 * `SUPABASE_SCANNER_BUFFER_SIZE` as the `bufio.Scanner`'s max token size — but only
 * when the env var is actually SET: `parseFile`
 * otherwise grows the package-level `parser.MaxScannerCapacity` to the real file's
 * byte length before the scan even starts (`viper.IsSet("SCANNER_BUFFER_SIZE")`
 * gates the auto-growth), so the DEFAULT (unset) path can never hit
 * `bufio.ErrTooLong` for a file read this way — no single statement can be bigger
 * than the whole file. Every caller of `execMigrationBatch` mirrors exactly this
 * Go call site (`ApplyMigrations`, `SeedGlobals`, `applySchemaFiles` all read their
 * file via `NewMigrationFromFile`/`parseFile`), so this is the correct single home
 * for the check (CLI-1958 review) rather than duplicating it per caller.
 *
 * Fails on the FIRST raw (pre-trim) statement
 * whose byte length exceeds the effective limit (`Math.max(configured,
 * GO_SCANNER_START_BUF_SIZE)` — see that constant's comment). `"After statement
 * <n>: …"` reports the count and RAW text of the last statement successfully
 * scanned BEFORE the oversized one: the scan loop body
 * never runs for the failing scan, so the last token still holds whatever the
 * previous iteration left it as (`""` if the very first statement is already
 * oversized) — verified empirically. This is a "read"-phase failure (returns
 * before a suggestion is ever set), so it carries no
 * suggestion, same as the file-open failure above.
 *
 * `projectEnv`, when given, is the caller's already-loaded `legacyLoadProjectEnv` map:
 * `loadNestedEnv` `os.Setenv`s every project-`.env`
 * key that isn't already in the shell env BEFORE `ParseDatabaseConfig` returns — i.e.
 * before ANY command body (including this scan) runs — so `viper.AutomaticEnv()` sees a
 * `supabase/.env`-only `SUPABASE_SCANNER_BUFFER_SIZE` exactly like a real shell-exported
 * one. Defaults to `{}` for callers that haven't threaded a project-env map through
 * (shell-only, same as before this parameter existed).
 */
export const checkScannerBufferSize = <E>(
  content: string,
  mapError: (message: string, phase: "read" | "exec") => E,
  projectEnv: Readonly<Record<string, string>> = {},
): Effect.Effect<void, E> => {
  const raw =
    process.env["SUPABASE_SCANNER_BUFFER_SIZE"] ?? projectEnv["SUPABASE_SCANNER_BUFFER_SIZE"];
  if (raw === undefined) return Effect.void;
  const configuredLimit = legacyParseScannerBufferSize(raw);
  // `configuredLimit <= 0` covers both an explicit non-positive size and an unparseable
  // value (e.g. a bare "5M", see `GO_DEFAULT_MAX_SCANNER_CAPACITY`'s comment) — Go's
  // `viper.GetSizeInBytes` collapses all of these to `0` too, and `parser.Split` then
  // falls back to its OWN hardcoded default cap, not to "no limit".
  const limit =
    configuredLimit > 0
      ? Math.max(configuredLimit, GO_SCANNER_START_BUF_SIZE)
      : GO_DEFAULT_MAX_SCANNER_CAPACITY;
  // Go's suggestion reports `maxbuf>>10` — the EFFECTIVE cap actually passed to
  // `scanner.Buffer`, which is the raw configured value
  // (even below the `GO_SCANNER_START_BUF_SIZE` floor — the floor only affects when
  // `bufio.ErrTooLong` can fire, never the number Go prints) when positive, or the
  // hardcoded default once Go has fallen back to it.
  const reportedLimit = configuredLimit > 0 ? configuredLimit : GO_DEFAULT_MAX_SCANNER_CAPACITY;
  let emitted = 0;
  let lastRaw = "";
  for (const token of legacySplitSqlTokens(content)) {
    // A delimiter-terminated token is found (and emitted) by `parser.Split`'s scan in
    // the SAME `Scan()` call that fills the buffer to capacity — before Go's too-long
    // check is ever reached — so a token exactly AT `limit` still succeeds; only
    // strictly-over fails (`>`). The trailing, unterminated token (only ever the LAST
    // one `legacySplitSqlTokens` returns, if any — see `LegacySplitSqlToken.terminated`)
    // has no delimiter to find: once the buffer fills to `limit` bytes without one, the
    // too-long check fires immediately, without Go ever attempting the extra `Read()`
    // that would reveal real EOF — so a trailing token AT `limit` already fails (`>=`).
    const tooLong = token.terminated
      ? utf8ByteLength(token.raw) > limit
      : utf8ByteLength(token.raw) >= limit;
    if (tooLong) {
      const suggestion = `Try setting SUPABASE_SCANNER_BUFFER_SIZE=5MB (current size is ${Math.floor(reportedLimit / 1024)}KB)`;
      return Effect.fail(
        mapError(
          `bufio.Scanner: token too long\nAfter statement ${emitted}: ${lastRaw}\n${suggestion}`,
          "read",
        ),
      );
    }
    // `token = scanner.Text()` runs on EVERY successful
    // `Scan()` — unconditionally, before the `len(trim) > 0` gate that decides whether to
    // `append` to `stats` — so `token` (and therefore the eventual `bufio.ErrTooLong`
    // message) reflects the last RAW text scanned even when that statement trimmed to
    // empty and was never appended (e.g. a lone `;` immediately before an oversized
    // statement reports "After statement N: ;", not a blank token). `emitted` mirrors
    // `len(stats)` (append-gated); `lastRaw` must NOT share that gate — verified
    // against the Go source directly (review CLI-1958 round 18).
    lastRaw = token.raw;
    if (token.trimmed.length > 0) {
      emitted += 1;
    }
  }
  return Effect.void;
};

/**
 * Port of `markError`: renders a `^` caret
 * line under the error position of the failing statement. `pos` is the server's
 * 1-based error cursor (`pgErr.Position`); Go consumes it against **byte**
 * lengths (`len(line)` on a Go string counts UTF-8 bytes) and pads the caret with
 * `pos-1` space bytes, so multibyte statements shift the caret exactly as Go does
 * (verified empirically against the Go implementation). The caret line REPLACES
 * every line after the error line (`append(lines[:j+1], caret)` truncates
 * the tail). Position 0 (absent), a position past the end of the statement, or
 * one landing exactly on a line break leave the statement untouched.
 */
export const legacyMarkError = (stat: string, pos: number): string => {
  const lines = stat.split("\n");
  for (const [j, line] of lines.entries()) {
    const c = utf8ByteLength(line);
    if (pos > c) {
      pos -= c + 1;
      continue;
    }
    // Show a caret below the error position
    if (pos > 0) {
      return [...lines.slice(0, j + 1), `${" ".repeat(pos - 1)}^`].join("\n");
    }
    break;
  }
  return stat;
};

// `typeNamePattern`: extracts the type name from
// PostgreSQL error messages like `type "ltree" does not exist`. Unanchored, so it
// matches identically inside the rendered `ERROR: … (SQLSTATE …)` head line.
const TYPE_NAME_PATTERN = /type "([^"]+)" does not exist/;

/**
 * Mirrors `MigrationFile.ExecBatch` error context:
 * on a failed statement, render the `^` caret under the server-reported error
 * position, the `Detail` line when present, the SQLSTATE-42704 extension hint,
 * then `At statement: <index>` and the (caret-marked) statement text. The
 * structured `detail`/`position` fields are only set by the driver for server
 * ErrorResponses, mirroring `errors.As(err, &pgErr)` gate.
 *
 * Exported so any caller that runs a raw batch-equivalent statement set outside a real
 * migration file (e.g. `legacyResetRecreateDatabases`'s PG14 `DROP`/`CREATE DATABASE`
 * statements, which are also routed through this exact formatter) gets
 * the same rich error context instead of the bare driver error.
 */
export const legacyFormatExecBatchError = (
  e: LegacyDbExecError,
  index: number,
  stat: string,
): Error => {
  const marked = legacyMarkError(stat, e.position ?? 0);
  const msg: Array<string> = [];
  if (e.detail !== undefined && e.detail.length > 0) {
    msg.push(e.detail);
  }
  // Provide helpful hint for extension type errors (SQLSTATE 42704: undefined_object)
  const typeName = TYPE_NAME_PATTERN.exec(e.message)?.[1];
  if (typeName !== undefined && e.code === "42704" && !typeName.includes(".")) {
    msg.push("");
    msg.push("Hint: This type may be defined in a schema that's not in your search_path.");
    msg.push("      Use schema-qualified type references to avoid this error:");
    msg.push(`        CREATE TABLE example (col extensions.${typeName});`);
    msg.push("      Learn more: supabase migration new --help");
  }
  msg.push(`At statement: ${index}`, marked);
  return formattedExecBatchFailure(`${legacyErrorMessage(e)}\n${msg.join("\n")}`, e);
};

/** Retains the server ErrorResponse after adding Go-compatible statement context. */
const FormattedExecBatchDbErrorId: unique symbol = Symbol("FormattedExecBatchDbError");
type FormattedExecBatchFailure = Error & {
  readonly [FormattedExecBatchDbErrorId]: LegacyDbExecError;
};
const formattedExecBatchFailure = (
  message: string,
  dbError: LegacyDbExecError,
): FormattedExecBatchFailure =>
  Object.assign(new Error(message), { [FormattedExecBatchDbErrorId]: dbError });

const formattedExecBatchDbError = (error: unknown): LegacyDbExecError | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const dbError: unknown = Reflect.get(error, FormattedExecBatchDbErrorId);
  return dbError instanceof LegacyDbExecError ? dbError : undefined;
};

/**
 * Runs a single migration/seed file's statements (plus the optional history insert).
 * Statements run inside an explicitly transactional extended-protocol batch
 * (supabase/cli#6347), except pipeline-incompatible ones
 * (`legacyIsPipelineIncompatible` — `CREATE INDEX CONCURRENTLY`, `VACUUM`, …) which
 * cannot run in a transaction block: the open batch is flushed (committed), the
 * statement runs standalone, then batching resumes (supabase/cli#5156). The history
 * insert goes in the final batch, so the migration is recorded only after every
 * statement succeeds. On a stepped-down session ({@link LegacyDbSession.restoreRoleSql})
 * the `postgres` role is re-asserted immediately after each top-level role-reverting
 * statement ({@link legacyRevertsToLoginRole}) and again at the end of the file before
 * the history insert (supabase/cli#6236), so the whole file behaves as on a password
 * session and leaves the session role-clean for whatever runs next. Injected restores
 * never shift `At statement: N` and are never recorded in the history row.
 * A file with no such statements uses one batch and one Sync.
 * Pg-delta files whose first line is `-- pg-delta: transaction=false` instead run
 * every statement sequentially without a CLI-owned transaction. This keeps their
 * session preamble, nontransactional action, and cleanup on the same connection.
 *
 * Does NOT create the history table and does not unconditionally `RESET ALL` —
 * those are the migration-apply path's responsibility, so ordinary role/globals
 * files (`legacySeedGlobals`) stay reset-free. (The role re-assert above is not
 * session hygiene but a connection-layer invariant, so it applies to every file
 * runner, globals included.) The one exception is best-effort
 * cleanup after a failed pg-delta no-transaction file. When `forceNoVersion` is set
 * the history insert is skipped regardless of filename.
 *
 * `projectEnv` is forwarded to {@link checkScannerBufferSize} — see its own doc comment
 * for why a project-`.env`-only `SUPABASE_SCANNER_BUFFER_SIZE` must be visible here too.
 */
const execMigrationBatch = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
  mapError: (message: string, phase: "read" | "exec", dbError?: LegacyDbExecError) => E,
  forceNoVersion: boolean,
  displayPath: string = migrationPath,
  projectEnv: Readonly<Record<string, string>> = {},
): Effect.Effect<void, E | LegacyDbConnectError> =>
  Effect.gen(function* () {
    // Receives an already-read/parsed file (the read
    // happens earlier, which wraps the open
    // failure as `"failed to open migration file: %w"`) —
    // so a read failure here is a DIFFERENT error class than a statement-execution
    // failure below, and needs the same prefix so stderr/JSON errors don't surface
    // the bare platform error text. Tagged "read" so callers that attach a suggestion
    // only around execution failures can tell the two apart.
    //
    // The workdir-RELATIVE form `[db.migrations].schema_paths`/
    // `[db.seed].sql_paths` already resolved to at config-load time is what should be
    // reported. This
    // module deliberately never `process.chdir`s (only `bootstrap` does, as its own
    // documented one-off), so callers must pass an ABSOLUTE `migrationPath` for the
    // real read to work — but that means the platform error's embedded path is
    // absolute too. When it differs from `displayPath` (the caller's relative
    // path), substitute it in so the wrapped message still reports the
    // relative form, not a leaked local temp/absolute path.
    //
    // Known residual delta (CLI-1958 review): `readFileString` decodes via `TextDecoder`
    // with `fatal: false` (the Effect `FileSystem` default), so an invalid-UTF-8 byte
    // sequence in the file is lossily replaced with U+FFFD before it ever reaches
    // `legacySplitAndTrim`/`session.exec`. `parseFile` instead scans the raw byte
    // stream and preserves those bytes verbatim into the statement strings it sends to
    // PostgreSQL. Reading raw bytes here (`fs.readFile`) and mapping them 1:1 into a
    // "binary string" would fix the split/parse stage, but the fix dies at the wire: the
    // shared `pg`/`pg-protocol` layer this session is built on unconditionally UTF-8-
    // encodes query text before writing it (`pg-protocol/dist/serializer.js` —
    // `buff.write(string, offset, 'utf-8')`, no raw-byte send API), so ANY string
    // representation still gets re-mangled at that boundary, just differently. Faithful
    // byte parity would require patching that shared wire-serializer — infrastructure
    // every legacy DB command's `session.exec` funnels through, not something scoped to
    // this file's read path — so it's flagged here rather than "fixed" underneath it.
    const content = yield* fs.readFileString(migrationPath).pipe(
      Effect.mapError((error) => {
        const message = legacyRelativizeErrorMessage(
          legacyErrorMessage(error),
          migrationPath,
          displayPath,
        );
        return mapError(`failed to open migration file: ${message}`, "read");
      }),
    );

    // Still `NewMigrationFromFile`/`parseFile`'s territory —
    // `parser.SplitAndTrim` runs INSIDE `parseFile`, before `ExecBatch` ever sees the
    // statements, so a `SUPABASE_SCANNER_BUFFER_SIZE` violation is a "read"-phase
    // failure like the open failure above, not an "exec"-phase one. See
    // `checkScannerBufferSize`'s comment for why this is a no-op unless the env var
    // is explicitly set.
    yield* checkScannerBufferSize(content, mapError, projectEnv);

    // Everything below mirrors `(*MigrationFile).ExecBatch` (`pkg/migration/file.go`),
    // which runs against an already-read file — so every failure from here on is an
    // execution failure, tagged "exec" (as opposed to the "read" failure above, which
    // mirrors `NewMigrationFromFile`). Only execution failures get `CmdSuggestion`;
    // callers rely on this tag to replicate that split.
    yield* Effect.gen(function* () {
      const { statements, transactionMode } = legacyParseMigrationContent(content);
      const filename = path.basename(migrationPath);
      const matches = MIGRATE_FILE_PATTERN.exec(filename);
      const version = forceNoVersion ? "" : (matches?.[1] ?? "");
      const name = matches?.[2] ?? "";

      const restoreRole = session.restoreRoleSql;

      const executeSequentially = (cleanup: string) =>
        Effect.gen(function* () {
          for (const [index, statement] of statements.entries()) {
            yield* session
              .exec(statement)
              .pipe(
                Effect.mapError((cause) => legacyFormatExecBatchError(cause, index, statement)),
              );
            if (restoreRole !== undefined && legacyRevertsToLoginRole(statement)) {
              yield* session
                .exec(restoreRole)
                .pipe(
                  Effect.mapError((cause) => legacyFormatExecBatchError(cause, index, restoreRole)),
                );
            }
          }
          if (
            restoreRole !== undefined &&
            !(statements.length > 0 && legacyRevertsToLoginRole(statements[statements.length - 1]!))
          ) {
            yield* session
              .exec(restoreRole)
              .pipe(
                Effect.mapError((cause) =>
                  legacyFormatExecBatchError(cause, statements.length, restoreRole),
                ),
              );
          }
          if (version.length > 0) {
            yield* session
              .query(INSERT_MIGRATION_VERSION, [version, name, statements])
              .pipe(
                Effect.mapError((cause) =>
                  legacyFormatExecBatchError(cause, statements.length, INSERT_MIGRATION_VERSION),
                ),
              );
          }
        }).pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              yield* session.exec(cleanup).pipe(Effect.ignore);
              // Sequential statements ran outside a CLI transaction, so a failed
              // file's `RESET ROLE` survives the cleanup; restore best-effort.
              if (restoreRole !== undefined) {
                yield* session.exec(restoreRole).pipe(Effect.ignore);
              }
            }),
          ),
        );

      // The pg-delta directive is file-level execution metadata. Run the complete
      // sequence on this session without adding transaction boundaries so session
      // settings remain active for the nontransactional action. History is recorded
      // only after every statement succeeds. A failed sequence gets a best-effort
      // session reset because the generated trailing RESET ALL may not have run yet.
      if (transactionMode === "none") {
        return yield* executeSequentially("RESET ALL");
      }

      // A headerless file with authored transaction boundaries owns those semantics.
      // Execute the statements exactly as written, clean up a failed authored
      // transaction, and only send the history insert after every statement succeeds.
      if (statements.some(legacyHasTransactionControl)) {
        return yield* executeSequentially("ROLLBACK");
      }

      // `executed` is the global statement index of the next statement to run, so the
      // error context stays accurate across flushed batches and standalone statements
      // (Go threads the same counter through `ExecBatch`).
      let pending: Array<string> = [];
      let executed = 0;
      let standaloneRestored = false;

      const flushBatch = (final: boolean) =>
        Effect.gen(function* () {
          const recordVersion = final && version.length > 0;
          // A standalone statement that just restored the role needs no trailing repeat.
          const trailingRestore =
            final && !(pending.length === 0 && standaloneRestored) ? restoreRole : undefined;
          if (pending.length === 0 && !recordVersion && trailingRestore === undefined) return;
          const batchStatements = pending;
          const operations: Array<LegacyDbBatchStatement> = [];
          // Injected role restores don't count toward `At statement: N`; track how
          // many precede each op so failures keep the file's own numbering (a
          // mid-file restore inherits its host statement's index; the trailing
          // restore and the history insert report the file's statement count).
          const injectedBefore: Array<number> = [];
          let injected = 0;
          let lastOpIsInjectedRestore = false;
          for (const sql of batchStatements) {
            operations.push({ sql });
            injectedBefore.push(injected);
            lastOpIsInjectedRestore = false;
            if (restoreRole !== undefined && legacyRevertsToLoginRole(sql)) {
              injected += 1;
              operations.push({ sql: restoreRole });
              injectedBefore.push(injected);
              lastOpIsInjectedRestore = true;
            }
          }
          if (trailingRestore !== undefined && !lastOpIsInjectedRestore) {
            operations.push({ sql: trailingRestore });
            injectedBefore.push(injected);
            injected += 1;
          }
          if (recordVersion) {
            operations.push({
              sql: INSERT_MIGRATION_VERSION,
              params: [version, name, statements],
            });
            injectedBefore.push(injected);
          }
          const base = executed;
          yield* session.execBatch(operations).pipe(
            Effect.mapError((cause) => {
              // The batch's connection failed, either on checkout or before any of
              // it reached the wire: there is no failing statement to name, so the
              // connect error is surfaced verbatim instead of `At statement: N`.
              if (cause instanceof LegacyDbConnectError) return cause;
              // `statementIndex` is set by every batch failure the driver raises; a
              // session that omits it can only have failed before the first statement.
              const raw = cause.statementIndex ?? 0;
              const globalIndex = base + raw - (injectedBefore[raw] ?? injected);
              return legacyFormatExecBatchError(
                cause,
                globalIndex,
                operations[raw]?.sql ?? statements[globalIndex] ?? INSERT_MIGRATION_VERSION,
              );
            }),
          );
          pending = [];
          executed += batchStatements.length;
        });

      for (const statement of statements) {
        if (legacyIsPipelineIncompatible(statement)) {
          // Flush the open batch, then run the incompatible statement on its own (no
          // surrounding transaction) so PostgreSQL accepts it.
          yield* flushBatch(false);
          const index = executed;
          yield* session
            .exec(statement)
            .pipe(Effect.mapError((cause) => legacyFormatExecBatchError(cause, index, statement)));
          standaloneRestored = false;
          if (restoreRole !== undefined && legacyRevertsToLoginRole(statement)) {
            yield* session
              .exec(restoreRole)
              .pipe(
                Effect.mapError((cause) => legacyFormatExecBatchError(cause, index, restoreRole)),
              );
            standaloneRestored = true;
          }
          executed += 1;
        } else {
          pending.push(statement);
          standaloneRestored = false;
        }
      }
      yield* flushBatch(true);
    }).pipe(
      Effect.mapError((error) =>
        // A batch connection failure is not an execution failure: it keeps its own
        // error class (and `suggestion`) all the way out, exactly like the connect
        // failure a caller would have seen from `connect` itself, instead of being
        // relabeled as this file's statement-execution failure.
        error instanceof LegacyDbConnectError
          ? error
          : mapError(legacyErrorMessage(error), "exec", formattedExecBatchDbError(error)),
      ),
    );
  });

/**
 * Go's per-migration connection reset: `RESET ALL` clears any
 * connection settings a prior statement on the same session may have changed
 * (e.g. `set_config('search_path', …)`), run before each migration's `ExecBatch`.
 * Only the migration-apply path does this — `SeedGlobals` (role/globals files)
 * must NOT, so this is a caller responsibility, never inside `execMigrationBatch`.
 */
const resetConnectionState = <E>(
  session: LegacyDbSession,
  mapError: (message: string) => E,
): Effect.Effect<void, E> =>
  session.exec("RESET ALL").pipe(Effect.mapError((e) => mapError(legacyErrorMessage(e))));

/**
 * Applies a single migration file to the connected database and records it in
 * `supabase_migrations.schema_migrations`. Mirrors `migration.ApplyMigrations`
 * for one file (`pkg/migration/apply.go` + `(*MigrationFile).ExecBatch`): `RESET ALL`
 * first to clear any session state leaked by a prior file (e.g.
 * `SET default_transaction_read_only = on`) before the history-table DDL, then create
 * the history table, then run the file's statements + the history insert.
 *
 * `mapError` lets the caller tag the failure (e.g. `LegacyPgDeltaDeclarativeApplyError`).
 * Statement failures also expose their structured PostgreSQL error so local replay
 * can classify precise SQLSTATE/object combinations without parsing formatted context.
 */
export const legacyApplyMigrationFile = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
  mapError: (message: string, dbError?: LegacyDbExecError) => E,
): Effect.Effect<void, E | LegacyDbConnectError> =>
  Effect.gen(function* () {
    yield* resetConnectionState(session, mapError);
    yield* legacyCreateMigrationTable(session).pipe(
      Effect.mapError((e) => mapError(legacyErrorMessage(e))),
    );
    yield* execMigrationBatch(
      session,
      fs,
      path,
      migrationPath,
      (message, _phase, dbError) => mapError(message, dbError),
      false,
    );
  });

/**
 * Applies a list of pending migration files, mirroring Go's
 * `migration.ApplyMigrations`: create the
 * history table once when there is anything to apply, then for each file emit
 * `Applying migration <name>...` to stderr, `RESET ALL`, and run it transactionally.
 */
export const legacyApplyMigrations = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  pending: ReadonlyArray<string>,
  mapError: (message: string) => E,
): Effect.Effect<void, E | LegacyDbConnectError, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (pending.length === 0) return;
    yield* legacyCreateMigrationTable(session).pipe(
      Effect.mapError((e) => mapError(legacyErrorMessage(e))),
    );
    // Sorted by version, not by file name: `db push` has applied in version
    // order since supabase/cli#6038, so callers that hand over a name-ordered
    // listing (`db reset`, the shadow-database replay) would otherwise apply the
    // same files in the opposite order (#6036). Idempotent for callers that
    // already sorted.
    for (const migrationPath of legacySortMigrationPathsByVersion(pending)) {
      yield* output.raw(`Applying migration ${path.basename(migrationPath)}...\n`, "stderr");
      // Reset connection state per migration before running the batch.
      yield* resetConnectionState(session, mapError);
      yield* execMigrationBatch(session, fs, path, migrationPath, mapError, false);
    }
  });

/**
 * Applies custom-role / globals files:
 * for each file emit `Seeding globals from
 * <name>...` to stderr and run it transactionally WITHOUT inserting a migration
 * history row, WITHOUT creating the history table, and WITHOUT
 * `RESET ALL`.
 */
export const legacySeedGlobals = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  globals: ReadonlyArray<string>,
  mapError: (message: string) => E,
): Effect.Effect<void, E | LegacyDbConnectError, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    for (const globalPath of globals) {
      yield* output.raw(`Seeding globals from ${path.basename(globalPath)}...\n`, "stderr");
      yield* execMigrationBatch(session, fs, path, globalPath, mapError, true);
    }
  });

/**
 * Runs one SQL file's statements transactionally, WITHOUT `legacySeedGlobals`'s
 * per-file `Seeding globals from <name>...` stderr message, WITHOUT inserting a
 * migration history row, WITHOUT creating the history table, and WITHOUT `RESET
 * ALL` (same batching semantics as `legacySeedGlobals`, `forceNoVersion: true`,
 * just silent). `initSchema`/`InitSchema14`/`ApplyApiPrivileges`-equivalent callers
 * run a batch DIRECTLY on an in-memory SQL constant — bypassing
 * `legacySeedGlobals`'s message — so reusing `legacySeedGlobals` for those
 * would print an extra, unwanted line. Callers write the in-memory SQL
 * constant to a temp file first (this module only reads files, like
 * `execMigrationBatch`'s other callers).
 *
 * `displayPath`, when given, is the path a read-failure's wrapped message should
 * report instead of `filePath` — see `execMigrationBatch`'s comment on why the two
 * can differ (an absolute path is required for the real read, but Go's equivalent
 * error names the workdir-relative form). `projectEnv`, when given, is forwarded to
 * {@link checkScannerBufferSize} via `execMigrationBatch` — see that helper's doc
 * comment.
 */
export const legacyExecSqlFile = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  filePath: string,
  mapError: (message: string, phase: "read" | "exec") => E,
  displayPath?: string,
  projectEnv?: Readonly<Record<string, string>>,
): Effect.Effect<void, E | LegacyDbConnectError> =>
  execMigrationBatch(session, fs, path, filePath, mapError, true, displayPath, projectEnv);

/**
 * Applies the EXPERIMENTAL declarative schema-files branch.
 * Reads `[db.migrations]
 * schema_paths` (already resolved to its config-load form — supabase-joined when
 * relative, verbatim when absolute) via the shared glob
 * ({@link legacySqlFilesGlob}), then runs each matched file's statements with
 * {@link legacyExecSqlFile} in glob order — no history table, no history row, and no
 * `RESET ALL` between files: connection state is never reset here (a stepped-down
 * session's role re-assert at each file's end is the one exception — see
 * {@link LegacyDbSession.restoreRoleSql}).
 *
 * Callers gate the call on the three-conjunct condition (`--experimental` + no resolved
 * version + pg-delta NOT enabled) themselves — this function only performs
 * the branch's body, mirroring `applySchemaFiles`'s own signature (it never re-checks the
 * gate). It is the caller's responsibility to skip `legacyApplyMigrations` entirely when
 * this is called (`if`/`else if` is mutually exclusive).
 *
 * Faithfully reproduces two undocumented, unfixed-upstream quirks that are load-bearing
 * for the strict 1:1 contract (CLI-1958):
 * - **Empty `schema_paths` (the `supabase init` default) silently applies nothing** and
 * returns success — globbing zero patterns returns no error, so
 * `applySchemaFiles` returns success too.
 * - **A PARTIAL glob failure is silently dropped**: per-pattern warnings are only
 * surfaced (as the returned failure) when NO pattern matched anything at all;
 * once at least one file is found, every other
 * pattern's warning is discarded — unlike the seed path's `WARN:` line.
 *
 * On a per-file EXECUTION failure only, attaches a `CmdSuggestion = "See schema file:
 * <Bold(fp)>"` via the optional second argument of `mapError`. A file-READ
 * failure returns before the suggestion is
 * ever set, so it must NOT carry the suggestion — {@link legacyExecSqlFile}'s `mapError`
 * receives the `"read"`/`"exec"` phase precisely so this call site can tell them apart.
 *
 * `projectEnv` is the caller's already-loaded `legacyLoadProjectEnv` map, forwarded to
 * {@link checkScannerBufferSize} (via `legacyExecSqlFile`/`execMigrationBatch`) so a
 * `SUPABASE_SCANNER_BUFFER_SIZE` set only in `supabase/.env` is honored here too —
 * see that helper's doc comment.
 */
export const legacyApplySchemaFiles = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  schemaPaths: ReadonlyArray<string>,
  mapError: (message: string, suggestion?: string) => E,
  projectEnv: Readonly<Record<string, string>> = {},
): Effect.Effect<void, E | LegacyDbConnectError> =>
  Effect.gen(function* () {
    const { files, warnings } = yield* legacySqlFilesGlob(fs, path, schemaPaths, workdir);
    if (files.length === 0) {
      // Go: `if len(declared) == 0 { return err }` — `err` is `nil` when there were no
      // patterns to glob at all, and the joined per-pattern warnings otherwise.
      if (warnings.length > 0) {
        return yield* Effect.fail(mapError(warnings.join("\n")));
      }
      return;
    }
    for (const file of files) {
      const absolutePath = path.isAbsolute(file) ? file : path.join(workdir, file);
      // `file` is already `fp` form (workdir-relative when the declared pattern
      // was relative, verbatim when absolute) — pass it through as the display path so
      // a read failure reports it instead of the `absolutePath` the real read needs.
      yield* legacyExecSqlFile(
        session,
        fs,
        path,
        absolutePath,
        (message, phase) =>
          phase === "exec"
            ? mapError(message, `See schema file: ${legacyBold(file)}`)
            : mapError(message),
        file,
        projectEnv,
      );
    }
  });
