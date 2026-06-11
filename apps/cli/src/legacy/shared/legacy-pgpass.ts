import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * libpq `.pgpass` password lookup, a 1:1 port of `jackc/pgpassfile`
 * (`ParsePassfile` + `FindPassword`) as used by `pgconn.ParseConfig`
 * (`config.go:369-378`): when a connection string omits the password, pgconn
 * reads the passfile and returns the first entry matching host/port/database/
 * user (with `*` wildcards). For a unix-socket host pgconn matches `localhost`.
 */

const TMP_BACKSLASH = "\r";
const TMP_COLON = "\n";

interface PgpassEntry {
  readonly hostname: string;
  readonly port: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

/**
 * Parse a single `.pgpass` line into an entry, or `undefined` for comments and
 * unparsable lines. Handles `\\` and `\:` escapes via temporary placeholders,
 * then splits on the remaining unescaped colons (must yield exactly 5 fields).
 */
function parsePgpassLine(line: string): PgpassEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }
  const escaped = trimmed.replaceAll("\\\\", TMP_BACKSLASH).replaceAll("\\:", TMP_COLON);
  const parts = escaped.split(":");
  if (parts.length !== 5) {
    return undefined;
  }
  const unescape = (part: string): string =>
    part.replaceAll(TMP_BACKSLASH, "\\").replaceAll(TMP_COLON, ":");
  return {
    hostname: unescape(parts[0]!),
    port: unescape(parts[1]!),
    database: unescape(parts[2]!),
    username: unescape(parts[3]!),
    password: unescape(parts[4]!),
  };
}

/**
 * Find the password for the given connection fields in `.pgpass` file contents,
 * returning the first matching entry's password (or `""`). Each entry field
 * matches when it is `*` or equals the connection field.
 */
export function legacyFindPgpassPassword(
  contents: string,
  hostname: string,
  port: string,
  database: string,
  username: string,
): string {
  for (const line of contents.split("\n")) {
    const entry = parsePgpassLine(line);
    if (entry === undefined) {
      continue;
    }
    if (
      (entry.hostname === "*" || entry.hostname === hostname) &&
      (entry.port === "*" || entry.port === port) &&
      (entry.database === "*" || entry.database === database) &&
      (entry.username === "*" || entry.username === username)
    ) {
      return entry.password;
    }
  }
  return "";
}

/** Environment lookup for `PGPASSFILE`/`APPDATA`; defaults to `process.env`. */
type LegacyPassfileEnv = (name: string) => string | undefined;
const processEnv: LegacyPassfileEnv = (name) => process.env[name];

/**
 * Resolve the passfile path with pgconn's precedence (`config.go:293,369-377`): an
 * explicit `passfile=` connection-string setting wins, then `PGPASSFILE`, then the
 * libpq per-OS default (`~/.pgpass`, or `%APPDATA%/postgresql/pgpass.conf`).
 *
 * A *present* `passfile` (even an empty string) is authoritative: an empty value
 * resolves to no usable passfile (`undefined`) rather than falling back to
 * `PGPASSFILE`/the default, mirroring pgconn calling `ReadPassfile("")` (→
 * `os.Open("")` fails → no `.pgpass` lookup → empty password). Only an *absent*
 * (`undefined`) setting falls through to `PGPASSFILE`/the default.
 */
function pgpassFilePath(env: LegacyPassfileEnv, passfile: string | undefined): string | undefined {
  if (passfile !== undefined) {
    return passfile.length > 0 ? passfile : undefined;
  }
  const explicit = env("PGPASSFILE");
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  if (process.platform === "win32") {
    const appData = env("APPDATA");
    return appData !== undefined && appData.length > 0
      ? join(appData, "postgresql", "pgpass.conf")
      : undefined;
  }
  const home = homedir();
  return home.length > 0 ? join(home, ".pgpass") : undefined;
}

/**
 * Resolve a password from the `.pgpass` file for the given connection, or `""`
 * when the file is absent/unreadable or has no matching entry. A unix-socket
 * host (a path) matches `localhost`, mirroring pgconn's `NetworkAddress`.
 *
 * `env` supplies `PGPASSFILE`/`APPDATA` (defaults to `process.env`); `passfile` is
 * an explicit connection-string `passfile=` setting that takes precedence.
 */
export function legacyPgpassPassword(
  host: string,
  port: number,
  database: string,
  username: string,
  env: LegacyPassfileEnv = processEnv,
  passfile?: string,
): string {
  const path = pgpassFilePath(env, passfile);
  if (path === undefined) {
    return "";
  }
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const matchHost = host.startsWith("/") ? "localhost" : host;
  return legacyFindPgpassPassword(contents, matchHost, String(port), database, username);
}
