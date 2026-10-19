import { BRANCH_PROJECT_REF_PATTERN } from "../ref-patterns.ts";
import type { RemoteValue } from "./remote-value.ts";
import type { RemoteAliasFlag, TargetDeprecation } from "./target-selector.ts";

const ALIAS_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--db-url",
  "--project-ref",
  "--project-id",
]);
const ALIAS_SWITCH_FLAGS: ReadonlySet<string> = new Set(["--linked", "--local"]);
const SECRET_VALUE_FLAGS: ReadonlySet<string> = new Set(["--password", "-p", "--db-password"]);
const BOOLEAN_LITERALS: ReadonlySet<string> = new Set([
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "1",
  "0",
]);
const DB_URL_PATTERN = /^postgres(ql)?:\/\//;
const SAFE_TOKEN = /^[\w@%+=:,./-]+$/;

const shellQuote = (token: string): string =>
  SAFE_TOKEN.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;

/** The `--remote` spelling for `value`; a database URL is never echoed. */
export const remoteFlagText = (value: RemoteValue): string => {
  switch (value._tag) {
    case "Linked":
      return "--remote";
    case "Ref":
      return `--remote=${value.ref}`;
    case "Branch":
      return `--remote=${shellQuote(value.name)}`;
    case "DbUrl":
      return "--remote=<db-url>";
  }
};

const aliasNameOf = (token: string): string | undefined => {
  const name = token.replace(/=.*$/, "").replace(/^--no-/, "--");
  return ALIAS_VALUE_FLAGS.has(name) || ALIAS_SWITCH_FLAGS.has(name) ? name : undefined;
};

/**
 * `argv` with the deprecated selector tokens (and any `--remote` that `remote` replaces) removed,
 * database URLs and passwords redacted, and `remote` last so it cannot be read as the value of a
 * positional (ahead of a literal `--`).
 */
export const rebuildCommand = (argv: ReadonlyArray<string>, remote: string | undefined): string => {
  const kept: Array<string> = [];
  let tail: ReadonlyArray<string> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") {
      tail = argv.slice(index).map(shellQuote);
      break;
    }
    if (remote !== undefined && (token === "--remote" || token.startsWith("--remote="))) continue;
    const alias = aliasNameOf(token);
    if (alias !== undefined) {
      const next = argv[index + 1];
      const consumesNext =
        !token.includes("=") &&
        ((ALIAS_VALUE_FLAGS.has(alias) && next !== undefined) ||
          (ALIAS_SWITCH_FLAGS.has(alias) && next !== undefined && BOOLEAN_LITERALS.has(next)));
      if (consumesNext) index += 1;
      continue;
    }
    if (SECRET_VALUE_FLAGS.has(token) && argv[index + 1] !== undefined) {
      kept.push(token, "<redacted>");
      index += 1;
      continue;
    }
    const secretFlag = [...SECRET_VALUE_FLAGS].find((flag) => token.startsWith(`${flag}=`));
    if (secretFlag !== undefined) {
      kept.push(`${secretFlag}=<redacted>`);
      continue;
    }
    kept.push(DB_URL_PATTERN.test(token) ? "<db-url>" : shellQuote(token));
  }
  return ["supabase", ...kept, ...(remote === undefined ? [] : [remote]), ...tail].join(" ");
};

/** The project ref a Supabase connection string already names: `db.<ref>.<host>` or a `postgres.<ref>` pooler user. */
export const refFromDbUrl = (url: string, projectHost: string): string | undefined => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.startsWith("db.") && host.endsWith(`.${projectHost}`)) {
      const ref = host.slice("db.".length, host.length - projectHost.length - 1);
      if (BRANCH_PROJECT_REF_PATTERN.test(ref)) return ref;
    }
    const poolerRef = /^postgres\.([a-z]{20})$/.exec(decodeURIComponent(parsed.username))?.[1];
    return poolerRef;
  } catch {
    return undefined;
  }
};

const joinFlags = (flags: ReadonlyArray<RemoteAliasFlag>): string =>
  flags.length <= 2
    ? flags.join(" and ")
    : `${flags.slice(0, -1).join(", ")} and ${flags[flags.length - 1]}`;

/**
 * The warning for each deprecated selector the run used. `argv` is the real command line, so the
 * replacement shows the command the user ran; a database URL is never echoed.
 */
export const deprecationMessages = (
  deprecations: ReadonlyArray<TargetDeprecation>,
  context: { readonly argv: ReadonlyArray<string> | undefined; readonly projectHost: string },
): ReadonlyArray<string> =>
  deprecations.map((deprecation) => {
    const { argv } = context;
    if (deprecation.kind === "local") {
      const example = argv === undefined ? "" : `: ${rebuildCommand(argv, undefined)}`;
      return `--local isn't needed (local is the default) and will be removed in v4${example}`;
    }
    const remote = remoteFlagText(deprecation.remote);
    const example = argv === undefined ? "" : `: ${rebuildCommand(argv, remote)}`;
    const ref =
      deprecation.remote._tag === "DbUrl"
        ? refFromDbUrl(deprecation.remote.url, context.projectHost)
        : undefined;
    const alternative = ref === undefined ? "" : `, or --remote=${ref} with an access token set`;
    const verb = deprecation.flags.length > 1 ? "are" : "is";
    return `${joinFlags(deprecation.flags)} ${verb} deprecated and will be removed in v4. Use --remote instead${example}${alternative}`;
  });
