import { Effect } from "effect";

import type { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { legacyDropObjectsSql } from "../../../shared/legacy-drop-objects.ts";

/**
 * Drops all user-created database objects for `db reset`'s remote (`--db-url`)
 * path: runs the shared `legacyDropObjectsSql` `DO` block inside an
 * explicit transaction, mapping failures through the caller's error
 * constructor (no migration-history row).
 */
export const legacyDropUserSchemas = <E>(
  session: LegacyDbSession,
  mapError: (message: string) => E,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    // No `RESET ALL` before the drop: resetting would clear caller-supplied DB
    // URL runtime params (e.g. `options=-c statement_timeout=…`) on the remote
    // `db reset --db-url` path before the destructive statement runs.
    yield* session.exec("BEGIN");
    yield* session
      .exec(legacyDropObjectsSql)
      .pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)));
    yield* session.exec("COMMIT");
  }).pipe(Effect.mapError((error: LegacyDbExecError) => mapError(error.message)));
