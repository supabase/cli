import errorLinks from "./error-links.json" with { type: "json" };

/*
 * `error-links.json` is the `cli` slice of https://supabase.com/kb/error-links.json. Refresh it
 * with `pnpm --filter supabase run refresh:error-links`.
 */
const links: Readonly<Record<string, string>> = errorLinks;

const MAX_CAUSE_DEPTH = 8;

// Rendered by `toExecError` for a Postgres server error, for example `... (SQLSTATE 42P01)`.
const SQLSTATE_IN_MESSAGE = /\(SQLSTATE ([0-9A-Za-z]{5})\)/u;
// Management API failures read `unexpected <operation> status 403: <body>`.
const FORBIDDEN_STATUS = /\bstatus 403:/u;
// node-postgres reports a failed password exchange without a SQLSTATE.
const FAILED_PASSWORD_EXCHANGE = /failed SASL auth|SCRAM exchange: Wrong password/u;

/** Matches the code exactly, then upper-cased so a lower-case SQLSTATE still resolves. */
const lookupLink = (code: string): string | undefined => links[code] ?? links[code.toUpperCase()];

/** The first article for a string `code` on the error or on its `cause` chain. */
const linkFromCodeChain = (error: unknown): string | undefined => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null || seen.has(current)) return undefined;
    seen.add(current);
    const code = Reflect.get(current, "code");
    if (typeof code === "string") {
      const link = lookupLink(code);
      if (link !== undefined) return link;
    }
    current = Reflect.get(current, "cause");
  }
  return undefined;
};

const linkFromMessage = (message: string): string | undefined => {
  const sqlState = SQLSTATE_IN_MESSAGE.exec(message)?.[1];
  if (sqlState !== undefined) return lookupLink(sqlState);
  if (FAILED_PASSWORD_EXCHANGE.test(message)) return lookupLink("28P01");
  if (FORBIDDEN_STATUS.test(message)) return lookupLink("403");
  return undefined;
};

/**
 * The troubleshooting article for an error with a stable code, or `undefined` when the code has
 * no article. `message` is the normalized message, searched when the error carries no code.
 */
export const errorDocUrl = (error: unknown, message: string): string | undefined =>
  linkFromCodeChain(error) ?? linkFromMessage(message);
