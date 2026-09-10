/**
 * Pure flag-presence helpers for the `--db-url / --linked / --local` target selection shared by
 * `db lint`, `db advisors`, and `test db`.
 *
 * Effect CLI's parsed flags carry no "was this explicitly set" bit, so this re-derives it from
 * raw `process.argv`. The mutually-exclusive-group error's "were all set" list is alphabetically
 * sorted regardless of each command's own flag registration order, which `setFlags` always
 * returns. A value-consuming flag given in space form (`--flag value`) has its value token
 * skipped during the scan, so e.g. `--schema --linked` does not misdetect `--linked` as changed.
 */

export type DbConnType = "db-url" | "linked" | "local";

export interface DbTargetSelection {
  /** Alphabetically-sorted list of explicitly-set selector flags ("db-url", "linked", "local"). */
  readonly setFlags: ReadonlyArray<string>;
  /**
   * Changed-first selection: db-url > local > linked (if changed) > undefined (→ local
   * default). `undefined` means no selector was explicitly set; callers default to "local".
   */
  readonly connType: DbConnType | undefined;
}

/**
 * Long-form flags that consume the next token as their value in space-separated form
 * (`--flag value`), so the target-selector scan skips it. Also consulted by
 * `extractChangedFlagNames` across every command's argv, so this lists every value-consuming
 * flag declared anywhere under `commands/`; a missing entry can misdetect a flag's value token
 * as a global flag's long name. `db-target-flags.unit.test.ts` enforces coverage for
 * directly-declared flags; flags built through a name-parameterized helper are listed by hand.
 */
export const VALUE_CONSUMING_LONG_FLAGS = new Set([
  // db-family command flags
  "db-url",
  "password", // db push/pull/dump/remote (short -p)
  "sql-paths",
  "schema",
  "level",
  "fail-on",
  "type",
  // migration/db credential flag; consumes the next token as its value.
  "password",
  // inspect report flag
  "output-dir",
  // storage cp command flags (Flag.string / Flag.integer)
  "cache-control",
  "content-type",
  "jobs",
  // global flags (Flag.string / Flag.choice)
  "output",
  "output-format",
  "profile",
  "workdir",
  "network-id",
  "dns-resolver",
  "agent",
  // `--log-level` is not listed: an argv giving it a flag-shaped value fails the real parse
  // before any scanner here runs, so nothing can mis-consume around it. `--completions` prints
  // and exits before any handler runs, so these scans never see it either.
  // Every other value-consuming flag declared directly across commands/ (see the doc comment
  // above).
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
  "exposure",
  "file",
  "from",
  "from-backup",
  "git-branch",
  "import-map",
  "inspect-mode",
  "instances",
  "kind",
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
  "postgres-engine",
  "project-id",
  "project-ref",
  "query-timeout",
  "region",
  "release-channel",
  "remote-label",
  "remove-domains",
  "role",
  "runtime",
  "size",
  "source",
  "status",
  "sub",
  "swift-access-control",
  "tail",
  "template",
  "timestamp",
  "to",
  "token",
  "valid-for",
  "version",
  // Declared through a name-parameterized helper, invisible to the static scan (see the doc
  // comment above): `issue.command.ts`'s `issueOptionalTextFlag`. (The `stringSliceFlag`-built
  // names — domains, add-domains, remove-domains, config, exclude, override-name, db-unban-ip,
  // db-allow-cidr — are already listed in the sections above.)
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
  // experimental stack start flags
  "stack",
  "stack-id",
  "preparation",
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
 * Detects which of `--linked` / `--local` were explicitly set on the command line, for `seed
 * buckets` and `storage ls/cp/mv/rm`'s mutually-exclusive-flag error message.
 *
 * Effect CLI's parsed flags carry no "was this set" bit, so this re-derives it from raw argv,
 * skipping value tokens of space-separated value-consuming flags to avoid false positives. The
 * negation form (`--no-linked`/`--no-local`) counts as changed. Returned alphabetically sorted
 * (`["linked", "local"]`) so the rendered conflict string matches exactly.
 */
export function changedLinkedLocalFlags(args: ReadonlyArray<string>): ReadonlyArray<string> {
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
 * Resolves the DB target selection from raw CLI args with a single left-to-right pass, skipping
 * value tokens that follow space-separated value-consuming flags to avoid false-positive
 * detection.
 *
 * `setFlags` is built in the fixed alphabetical order `["db-url", "linked", "local"]` so the
 * rendered conflict string (`[db-url linked]`, `[linked local]`, …) matches exactly.
 *
 * `connType` follows Changed-first precedence:
 * 1. `--db-url` if changed → "db-url"
 * 2. `--local` if changed → "local"
 * 3. `--linked` if changed → "linked"
 * 4. none changed → `undefined` (callers default to "local")
 */
export function resolveDbTargetFlags(args: ReadonlyArray<string>): DbTargetSelection {
  let dbUrlChanged = false;
  let linkedChanged = false;
  let localChanged = false;

  let skipNext = false;
  for (const token of args) {
    // A value-consuming flag consumes the next token as its value even when that token is "--".
    // Only a "--" that is not a pending value acts as the end-of-options sentinel.
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

  let connType: DbConnType | undefined;
  if (dbUrlChanged) {
    connType = "db-url";
  } else if (localChanged) {
    connType = "local";
  } else if (linkedChanged) {
    connType = "linked";
  }

  return { setFlags, connType };
}
