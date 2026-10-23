import { GEN_TYPES_LANGUAGE_VALUE_FLAG_NAMES } from "../../commands/gen/types/types.languages.ts";

/**
 * Long flags that consume the next token in space form. Also used by `extractChangedFlagNames`
 * across every command's argv, so it lists every value flag under `commands/`; the unit test
 * enforces coverage for directly-declared flags, helper-built ones are listed by hand.
 */
export const VALUE_CONSUMING_LONG_FLAGS = new Set([
  "db-url",
  "password", // db push/pull/dump/remote (short -p)
  "sql-paths",
  "schema",
  "level",
  "fail-on",
  "type",
  "output-dir",
  "cache-control",
  "content-type",
  "jobs",
  "output",
  "output-format",
  "profile",
  "workdir",
  "network-id",
  "dns-resolver",
  "agent",
  // `--log-level` and `--completions` are unlisted: the real parse or an early exit precedes
  // every scan here.
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
  ...GEN_TYPES_LANGUAGE_VALUE_FLAG_NAMES,
  "tail",
  "template",
  "timestamp",
  "to",
  "token",
  "valid-for",
  "version",
  // Built by `issueOptionalTextFlag`, invisible to the static scan.
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
  "capability",
  "service",
  "since",
  "stack",
  "stack-id",
  "preparation",
]);

/** Single-character short flags (no `-` prefix) that consume the next token. */
export const VALUE_CONSUMING_SHORT_FLAGS = new Set([
  "s", // --schema / -s
  "o", // --output / -o
  "p", // --password / -p (migration list, db push/pull/dump/remote)
  "j", // --jobs / -j (storage cp)
  "f", // --file / -f (db dump/diff/query, db schema declarative sync)
  "t", // --template / -t (test new); --type / -t (sso add); --timestamp / -t (backups restore)
  "x", // --exclude / -x (start, db dump)
]);
