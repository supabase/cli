import { Effect } from "effect";

import type { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import type { DbSession } from "../../../command-internal/db-connection.service.ts";
import { dropObjectsSql } from "../../../command-internal/drop-objects.ts";

/**
 * Drops all user-created database objects for `db reset`'s remote (`--db-url`)
 * path: runs the shared `dropObjectsSql` `DO` block inside an
 * explicit transaction, mapping failures through the caller's error
 * constructor (no migration-history row).
 */
export const dropUserSchemas = <E>(
  session: DbSession,
  mapError: (message: string) => E,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    // No `RESET ALL` before the drop: resetting would clear caller-supplied DB
    // URL runtime params (e.g. `options=-c statement_timeout=…`) on the remote
    // `db reset --db-url` path before the destructive statement runs.
    yield* session.exec("BEGIN");
    yield* session
      .exec(dropObjectsSql)
      .pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)));
    yield* session.exec("COMMIT");
  }).pipe(Effect.mapError((error: DbExecError) => mapError(error.message)));
