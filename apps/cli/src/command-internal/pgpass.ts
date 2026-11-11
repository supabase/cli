import { homedir } from "node:os";
import { type Cause, Effect, FileSystem, Option, Path } from "effect";

/**
 * libpq `.pgpass` password lookup: when a connection string omits the password, this reads
 * the passfile and returns the first entry matching host/port/database/user (with `*`
 * wildcards). A unix-socket host matches `localhost`.
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
export function findPgpassPassword(
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

/** Environment lookup for `PGPASSFILE`/`APPDATA`. */
type PassfileEnv = (name: "APPDATA" | "PGPASSFILE") => string | undefined;

/**
 * Resolves the passfile path with libpq precedence: an explicit `passfile=`
 * connection-string setting wins, then `PGPASSFILE`, then the per-OS default (`~/.pgpass`, or
 * `%APPDATA%/postgresql/pgpass.conf`).
 *
 * A *present* `passfile` (even an empty string) is authoritative: an empty value resolves to
 * no usable passfile (`undefined`) rather than falling back to `PGPASSFILE`/the default. Only
 * an *absent* (`undefined`) setting falls through.
 */
const pgpassFilePath = Effect.fnUntraced(function* (
  env: PassfileEnv,
  passfile: string | undefined,
): Effect.fn.Return<string | undefined, Cause.UnknownError, Path.Path> {
  const path = yield* Path.Path;
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
      ? path.join(appData, "postgresql", "pgpass.conf")
      : undefined;
  }
  const home = yield* Effect.try(() => homedir());
  return home.length > 0 ? path.join(home, ".pgpass") : undefined;
});

/**
 * Resolves a password from the `.pgpass` file for the given connection, or `""` when the
 * file is absent/unreadable or has no matching entry. A unix-socket host (a path) matches
 * `localhost`.
 *
 * `env` supplies `PGPASSFILE`/`APPDATA`; `passfile` is an
 * explicit connection-string `passfile=` setting that takes precedence.
 */
export const pgpassPassword = Effect.fnUntraced(function* (
  host: string,
  port: number,
  database: string,
  username: string,
  env: PassfileEnv,
  passfile?: string,
): Effect.fn.Return<string, Cause.UnknownError, FileSystem.FileSystem | Path.Path> {
  const path = yield* pgpassFilePath(env, passfile);
  if (path === undefined) {
    return "";
  }
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path).pipe(Effect.option);
  if (Option.isNone(contents)) {
    return "";
  }
  const matchHost = host.startsWith("/") ? "localhost" : host;
  return findPgpassPassword(contents.value, matchHost, String(port), database, username);
});
