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

const aliasMessage = (
  deprecation: Extract<TargetDeprecation, { readonly kind: "remote-alias" }>,
  projectHost: string,
): string => {
  const { flags, remote } = deprecation;
  const verb = flags.length > 1 ? "are" : "is";
  const lead = `${joinFlags(flags)} ${verb} deprecated and will be removed in v4.`;

  if (remote._tag === "Branch" && isBooleanLiteral(remote.name)) {
    return `${lead} Reach a branch named "${remote.name}" with ${BRANCH_BY_REF} instead`;
  }
  if (remote._tag === "DbUrl" && !DB_URL_PATTERN.test(remote.url)) {
    return `${lead} Convert the connection string to a postgresql:// URL and pass it as --remote=<url> instead`;
  }
  const ref = remote._tag === "DbUrl" ? refFromDbUrl(remote.url, projectHost) : undefined;
  const alternative = ref === undefined ? "" : `, or --remote=${ref} with an access token set`;
  return `${lead} Use ${replacementOf(remote)} instead${alternative}`;
};

/** The warning for each deprecated selector the run used, naming its `--remote` replacement; a database URL is never echoed. */
export const deprecationMessages = (
  deprecations: ReadonlyArray<TargetDeprecation>,
  projectHost: string,
): ReadonlyArray<string> =>
  deprecations.map((deprecation) =>
    deprecation.kind === "local"
      ? "--local isn't needed (local is the default) and will be removed in v4"
      : aliasMessage(deprecation, projectHost),
  );
