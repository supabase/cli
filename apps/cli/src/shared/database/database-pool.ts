import { Effect } from "effect";
import pg from "pg";
import { parseSslConfig } from "@supabase/pg-delta/frontends";

export const acquireDatabasePool = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const { ssl, cleanedUrl } = parseSslConfig(connectionString);
      const pool = new pg.Pool({
        connectionString: cleanedUrl,
        max: 5,
        ...(ssl !== undefined ? { ssl } : {}),
      });
      pool.on("error", () => undefined);
      return pool;
    }),
    (pool) => Effect.promise(() => pool.end()),
  );
