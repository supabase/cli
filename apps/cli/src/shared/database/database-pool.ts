import { Effect } from "effect";
import pg from "pg";
import { parseSslConfig } from "@supabase/pg-delta/frontends";

const SUPERUSER_ROLE = "supabase_admin";
const CLI_LOGIN_PREFIX = "cli_login_";
const SET_SESSION_ROLE = "SET SESSION ROLE postgres";

/** Hosted `postgres` rolconfig. SET ROLE does not adopt it; RESET ALL drops it. */
export const PLATFORM_SEARCH_PATH_SQL = `SET search_path TO "$user", public, extensions`;

/**
 * Same rule as LegacyDbConnection remote AfterConnect: minted `cli_login_*`
 * and `supabase_admin` must become `postgres` so owner-only
 * `supabase_migrations` is usable. Strips a Supavisor `.{ref}` suffix first.
 */
export function needsRoleStepDown(user: string): boolean {
  const base = user.split(".")[0] ?? user;
  return base.toLowerCase() === SUPERUSER_ROLE || base.startsWith(CLI_LOGIN_PREFIX);
}

function connectionUser(connectionString: string): string | undefined {
  try {
    const user = decodeURIComponent(new URL(connectionString).username);
    return user.length > 0 ? user : undefined;
  } catch {
    return undefined;
  }
}

type StepDownClient = {
  readonly query: (sql: string) => Promise<unknown>;
};

type DatabasePoolConfig = pg.PoolConfig & {
  readonly verify?: typeof databasePoolStepDownVerify;
};

const toPoolError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** pg-pool `verify`: every new physical connection steps down before checkout. */
export function databasePoolStepDownVerify(
  client: StepDownClient,
  callback: (err?: Error) => void,
): void {
  client.query(SET_SESSION_ROLE).then(
    () =>
      client.query(PLATFORM_SEARCH_PATH_SQL).then(
        () => callback(),
        (error) => callback(toPoolError(error)),
      ),
    (error) => callback(toPoolError(error)),
  );
}

export const acquireDatabasePool = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const { ssl, cleanedUrl } = parseSslConfig(connectionString);
      const user = connectionUser(cleanedUrl);
      const stepDownRequired = user !== undefined && needsRoleStepDown(user);
      const config: DatabasePoolConfig = {
        connectionString: cleanedUrl,
        max: 5,
        ...(ssl !== undefined ? { ssl } : {}),
        ...(stepDownRequired ? { verify: databasePoolStepDownVerify } : {}),
      };
      const pool = new pg.Pool(config);
      pool.on("error", () => undefined);
      return pool;
    }),
    (pool) => Effect.promise(() => pool.end()),
  );
