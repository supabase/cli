import { Context, type Effect } from "effect";

import type { DeclarativeShadowDbError } from "./pgdelta.errors.ts";

interface DeclarativeSeamShape {
  /**
   * For the `--local` declarative paths: when the local Postgres container is not already
   * running, starts it (the same DB-only bring-up `db start` uses) so
   * `db schema declarative generate --local`/`sync` can bootstrap a stopped stack instead of
   * failing to connect. A no-op, silently, when the container is already running.
   */
  readonly ensureLocalDatabaseStarted: () => Effect.Effect<void, DeclarativeShadowDbError>;
  /**
   * Whether the local Postgres container exists. Inspect/daemon failures are
   * {@link DeclarativeShadowDbError}; a missing container is `false`, not a start.
   */
  readonly isLocalDatabaseRunning: () => Effect.Effect<boolean, DeclarativeShadowDbError>;
  /**
   * Checks the running local Postgres container image tag against the currently
   * resolved Postgres image. A missing container is accepted: catalog cache keys
   * self-invalidate on setup inputs, and local-apply paths will start/connect later.
   */
  readonly ensureLocalPostgresImageCurrent: () => Effect.Effect<void, DeclarativeShadowDbError>;
}

export class DeclarativeSeam extends Context.Service<DeclarativeSeam, DeclarativeSeamShape>()(
  "supabase/cli/DeclarativeSeam",
) {}
