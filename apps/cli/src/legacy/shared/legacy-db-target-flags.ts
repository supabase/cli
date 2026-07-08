/**
 * Pure flag-presence helpers for the `--db-url / --linked / --local` target
 * selection shared by `db lint`, `db advisors`, and `test db`.
 *
 * Go's cobra uses `pflag.Changed` to decide which selector was explicitly set by
 * the user (`apps/cli-go/internal/utils/flags/db_url.go:46-63`).  Effect CLI's
 * parsed flag values don't carry a `Changed` bit, so we re-derive it from the
 * raw `process.argv` slice.
 *
 * cobra's `MarkFlagsMutuallyExclusive` sorts the conflicting names before
 * building the error string (`apps/cli-go/.../flag_groups.go:204`), hence the
 * FIXED insertion order ["db-url","linked","local"] — alphabetical — for the
 * `setFlags` array.
 *
 * pflag accepts `--flag value` (space form) for non-boolean flags: the token
 * after a value-consuming flag is its value, not a separate flag. The scan
 * skips those value tokens to avoid false positives (e.g. `--schema --linked`
 * must not detect `--linked` as a changed selector).
 */

export type LegacyDbConnType = "db-url" | "linked" | "local";

export interface LegacyDbTargetSelection {
  /** Alphabetically-sorted list of explicitly-set selector flags ("db-url", "linked", "local"). */
  readonly setFlags: ReadonlyArray<string>;
  /**
   * Changed-first selection, matching Go's `ParseDatabaseConfig` precedence
   * (db_url.go:46-63): db-url > local > linked (if changed) > undefined (→ local default).
   *
   * `undefined` means no selector was explicitly set; callers default to "local".
   */
  readonly connType: LegacyDbConnType | undefined;
}

/**
 * Long-form flags (without `--` prefix) that consume the next token as their
 * value when given in space-separated form (`--flag value`). Flags in this set
 * cause the immediately following token to be skipped during the target-selector
 * scan.
 *
 * Sources: every legacy command that calls `resolveLegacyDbTargetFlags`
 * (`db lint`, `db advisors`, `test db`, and the `migration` commands `list`/
 * `repair`/`fetch`/`up`/`down`) or `legacyChangedLinkedLocalFlags`
 * (`seed buckets`, `storage cp/ls/mv/rm`), plus the shared global flags
 * (`src/shared/legacy/global-flags.ts`, `src/shared/cli/global-flags.ts`).
 * `Flag.string` / `Flag.choice` / `Flag.integer` → value-consuming;
 * `Flag.boolean` → not.
 *
 * Also consulted by `extractChangedFlagNames`
 * (`legacy/telemetry/legacy-command-instrumentation.ts`), which scans EVERY
 * legacy command's raw argv, not just the db-target/global subset above — so
 * this set additionally lists every other value-consuming (non-boolean) flag
 * declared anywhere under `legacy/commands/`. Without an entry here, a bare
 * `--some-local-flag <token>` is mis-scanned: the value token is treated as a
 * separate flag rather than skipped, and if that token happens to look like a
 * global flag's long name (e.g. `secrets set --env-file --debug`, where
 * `--debug` is `--env-file`'s value under pflag semantics), CLI-1896's
 * global-flag fallback fabricates a `flags.debug` value Go never records for
 * that invocation. `legacy-db-target-flags.unit.test.ts` statically scans
 * every `*.command.ts` file's directly-declared `Flag.string`/`Flag.integer`/
 * `Flag.choice`/`Flag.choiceWithValue` calls and asserts they're all
 * represented here, so a new command that adds a value-consuming flag and
 * forgets to register it fails CI. That scan cannot see flag names built
 * through a helper indirection (`issue.command.ts`'s
 * `legacyIssueOptionalTextFlag`, `status.command.ts`'s `csvStringSliceFlag`)
 * — those flags are listed below by hand and excluded from the scan.
 */
export const VALUE_CONSUMING_LONG_FLAGS = new Set([
  // db-family command flags
  "db-url",
  "password", // db push/pull/dump/remote (StringVarP, short -p)
  "sql-paths",
  "schema",
  "level",
  "fail-on",
  "type",
  // migration/db credential flag — Go's `StringVarP(&dbPassword, "password", "p", …)`
  // consumes the next token as the value (`apps/cli-go/cmd/migration.go:115,127`).
  "password",
  // inspect report flag (StringVar, no short alias)
  "output-dir",
  // storage cp command flags (Flag.string / Flag.integer)
  "cache-control",
  "content-type",
  "jobs",
  // legacy global flags (Flag.string / Flag.choice)
  "output",
  "output-format",
  "profile",
  "workdir",
  "network-id",
  "dns-resolver",
  "agent",
  // Every other value-consuming flag declared directly across legacy/commands/
  // (CLI-1896 review follow-up — see the doc comment above).
  "add-domains",
  "algorithm",
  "attribute-mapping-file",
  "auth",
  "config",
  "custom-hostname",
  "db-allow-cidr",
  "db-password",
  "db-unban-ip",
  "desired-subdomain",
  "diff-engine",
  "domains",
  "env-file",
  "exclude",
  "exp",
  "file",
  "from",
  "from-backup",
  "git-branch",
  "import-map",
  "inspect-mode",
  "lang",
  "last",
  "metadata-file",
  "metadata-url",
  "name",
  "name-id-format",
  "notify-url",
  "org-id",
  "override-name",
  "payload",
  "plan",
  "project-id",
  "project-ref",
  "query-timeout",
  "region",
  "remove-domains",
  "role",
  "size",
  "status",
  "sub",
  "swift-access-control",
  "template",
  "timestamp",
  "to",
  "token",
  "valid-for",
  "version",
  // Declared through a name-parameterized helper, invisible to the static
  // scan (see the doc comment above): `issue.command.ts`'s
  // `legacyIssueOptionalTextFlag` and `status.command.ts`'s
  // `csvStringSliceFlag`.
  "additional-context",
  "area",
  "command",
  "actual-output",
  "expected-behavior",
  "reproduce",
  "crash-report-id",
  "docker-services",
  "problem",
  "proposed-solution",
  "alternatives",
  "link",
  "issue-type",
  "improvement",
]);

/**
 * Short flags (without `-` prefix) that consume the next token as their value.
 * Only single-character short flags need to be listed here.
 */
export const VALUE_CONSUMING_SHORT_FLAGS = new Set([
  "s", // --schema / -s
  "o", // --output / -o
  "p", // --password / -p (migration list, db push/pull/dump/remote)
  "j", // --jobs / -j (storage cp)
  "f", // --file / -f (db dump/diff/query, db schema declarative sync)
  "t", // --template / -t (test new); --type / -t (sso add); --timestamp / -t (backups restore)
  "x", // --exclude / -x (start, db dump)
]);

/**
 * Detects which of `--linked` / `--local` were explicitly set on the command
 * line, reproducing cobra's `pflag.Changed` for the `MarkFlagsMutuallyExclusive`
 * groups on `seedCmd` (`apps/cli-go/cmd/seed.go:32`) and `storageCmd`
 * (`apps/cli-go/cmd/storage.go:99`). Shared by `seed buckets` and
 * `storage ls/cp/mv/rm`.
 *
 * Effect CLI's parsed flags carry no `Changed` bit, so this re-derives it from
 * raw argv, skipping value tokens of space-separated value-consuming flags
 * (`--workdir <path>`, `-o <fmt>`, …) to avoid false positives. The negation
 * form (`--no-linked`/`--no-local`) counts as changed. Returned in cobra's
 * alphabetically-sorted order `["linked", "local"]` so the rendered conflict
 * string matches Go exactly.
 */
export function legacyChangedLinkedLocalFlags(args: ReadonlyArray<string>): ReadonlyArray<string> {
  let linked = false;
  let local = false;
  let skipNext = false;

  for (const token of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "--") break;

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
      const isBare = eqIdx === -1;
      if (name === "linked" || name === "no-linked") {
        linked = true;
        continue;
      }
      if (name === "local" || name === "no-local") {
        local = true;
        continue;
      }
      if (isBare && VALUE_CONSUMING_LONG_FLAGS.has(name)) skipNext = true;
      continue;
    }

    if (token.startsWith("-") && token.length >= 2 && token.charAt(1) !== "-") {
      if (token.length === 2 && VALUE_CONSUMING_SHORT_FLAGS.has(token.charAt(1))) {
        skipNext = true;
      }
    }
  }

  const setFlags: Array<string> = [];
  if (linked) setFlags.push("linked");
  if (local) setFlags.push("local");
  return setFlags;
}

/**
 * Resolves the DB target selection from raw CLI args.
 *
 * Performs a single left-to-right pass, skipping value tokens that follow
 * space-separated value-consuming flags to avoid false-positive detection.
 *
 * `setFlags` is built in the fixed order ["db-url","linked","local"] so the
 * rendered conflict string (`[db-url linked]`, `[linked local]`, …) matches
 * cobra's alphabetically-sorted output exactly.
 *
 * `connType` follows Go's Changed-first precedence (db_url.go:46-63):
 *   1. `--db-url` if changed → "db-url"
 *   2. `--local` if changed → "local"
 *   3. `--linked` if changed → "linked"
 *   4. none changed → `undefined` (callers default to "local")
 */
export function resolveLegacyDbTargetFlags(args: ReadonlyArray<string>): LegacyDbTargetSelection {
  let dbUrlChanged = false;
  let linkedChanged = false;
  let localChanged = false;

  let skipNext = false;
  for (const token of args) {
    // pflag: a value-consuming flag consumes the next token as its value even
    // when that token is "--". Only a "--" that is NOT a pending value acts as
    // the end-of-options sentinel.
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (token === "--") break;

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
      const isBare = eqIdx === -1;

      // Check target selectors.
      if (name === "db-url") {
        dbUrlChanged = true;
        // --db-url is a string flag: in space form the next token is the value.
        if (isBare) skipNext = true;
        continue;
      }
      if (name === "linked" || name === "no-linked") {
        linkedChanged = true;
        continue;
      }
      if (name === "local" || name === "no-local") {
        localChanged = true;
        continue;
      }

      // Non-target long flag: skip its value token if value-consuming and bare.
      if (isBare && VALUE_CONSUMING_LONG_FLAGS.has(name)) {
        skipNext = true;
      }
      continue;
    }

    // Short flags: `-s`, `-o`, etc.
    if (token.startsWith("-") && token.length >= 2 && token.charAt(1) !== "-") {
      const shortName = token.charAt(1);
      // `-s` bare (length === 2): next token is the value.
      // `-svalue` (length > 2): value is attached, no skip needed.
      if (token.length === 2 && VALUE_CONSUMING_SHORT_FLAGS.has(shortName)) {
        skipNext = true;
      }
    }
  }

  const setFlags: Array<string> = [];
  if (dbUrlChanged) setFlags.push("db-url");
  if (linkedChanged) setFlags.push("linked");
  if (localChanged) setFlags.push("local");

  let connType: LegacyDbConnType | undefined;
  if (dbUrlChanged) {
    connType = "db-url";
  } else if (localChanged) {
    connType = "local";
  } else if (linkedChanged) {
    connType = "linked";
  }

  return { setFlags, connType };
}
