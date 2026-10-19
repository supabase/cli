import { BRANCH_PROJECT_REF_PATTERN } from "../ref-patterns.ts";
import type { RemoteValue } from "./remote-value.ts";
import { DB_URL_PATTERN, isBooleanLiteral, stripUserinfo } from "./remote-vocabulary.ts";
import { joinFlags, type TargetDeprecation } from "./target-selector.ts";

const SAFE_TOKEN = /^[\w@%+=:,./-]+$/;

export const shellQuote = (token: string): string =>
  SAFE_TOKEN.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;

const BRANCH_BY_REF = "--remote=<its ref or UUID>";

/** The `--remote` spelling for `value`; a database URL is never echoed, nor is a branch name's userinfo. */
export const remoteFlagText = (value: RemoteValue): string => {
  switch (value._tag) {
    case "Linked":
      return "--remote";
    case "Ref":
      return `--remote=${value.ref}`;
    case "Branch":
      return isBooleanLiteral(value.name)
        ? BRANCH_BY_REF
        : `--remote=${shellQuote(stripUserinfo(value.name))}`;
    case "DbUrl":
      return "--remote=<db-url>";
  }
};

/** The `--remote` form a deprecated flag's value maps to, with a placeholder where the user's own value goes. */
const replacementOf = (value: RemoteValue): string => {
  switch (value._tag) {
    case "Linked":
      return "--remote";
    case "Ref":
      return "--remote=<ref>";
    case "Branch":
      return isBooleanLiteral(value.name) ? BRANCH_BY_REF : "--remote=<branch>";
    case "DbUrl":
      return DB_URL_PATTERN.test(value.url) ? "--remote=<db-url>" : "--remote=<url>";
  }
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

/** The command the warning's example runs: its path and operand placeholders, never the user's own operands. */
export interface DeprecationCommand {
  /** The resolved command path, e.g. `db push`. */
  readonly path: string;
  /** The operand placeholders from the command's help, e.g. `<NAME=VALUE>...`. */
  readonly operands: ReadonlyArray<string>;
}

const exampleOf = (command: DeprecationCommand | undefined, remote: string | undefined): string =>
  command === undefined
    ? ""
    : `: ${["supabase", command.path, ...command.operands, ...(remote === undefined ? [] : [remote])].join(" ")}`;

const aliasMessage = (
  deprecation: Extract<TargetDeprecation, { readonly kind: "remote-alias" }>,
  context: { readonly command: DeprecationCommand | undefined; readonly projectHost: string },
): string => {
  const { flags, remote } = deprecation;
  const verb = flags.length > 1 ? "are" : "is";
  const lead = `${joinFlags(flags)} ${verb} deprecated and will be removed in v4.`;
  const example = exampleOf(context.command, remoteFlagText(remote));

  if (remote._tag === "Branch" && isBooleanLiteral(remote.name)) {
    return `${lead} Reach a branch named "${remote.name}" with ${BRANCH_BY_REF} instead${example}`;
  }
  if (remote._tag === "DbUrl" && !DB_URL_PATTERN.test(remote.url)) {
    return `${lead} Convert the connection string to a postgresql:// URL and pass it as --remote=<url> instead${exampleOf(context.command, "--remote=<url>")}`;
  }
  const ref = remote._tag === "DbUrl" ? refFromDbUrl(remote.url, context.projectHost) : undefined;
  const alternative = ref === undefined ? "" : `, or --remote=${ref} with an access token set`;
  return `${lead} Use ${replacementOf(remote)} instead${example}${alternative}`;
};

/**
 * The warning for each deprecated selector the run used. It shows the command path, its operand
 * placeholders and the `--remote` replacement last; the user's own operands, other flags and
 * database URLs are never echoed, because any of them can be a secret.
 */
export const deprecationMessages = (
  deprecations: ReadonlyArray<TargetDeprecation>,
  context: {
    readonly command: DeprecationCommand | undefined;
    readonly projectHost: string;
  },
): ReadonlyArray<string> =>
  deprecations.map((deprecation) =>
    deprecation.kind === "local"
      ? `--local isn't needed (local is the default) and will be removed in v4${exampleOf(context.command, undefined)}`
      : aliasMessage(deprecation, context),
  );
