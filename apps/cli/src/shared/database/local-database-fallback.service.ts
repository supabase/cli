import { Context, type Effect, Option } from "effect";
import type { SchemaLocalStackNotRunningError } from "../schema/schema-errors.ts";
import type { DatabaseTarget } from "./database-target.ts";

interface LocalDatabaseFallbackShape {
  readonly resolve: Effect.Effect<Option.Option<DatabaseTarget>, SchemaLocalStackNotRunningError>;
}

/** Optional project-owned local DB from this project's Docker `supabase start`. */
export class LocalDatabaseFallback extends Context.Service<
  LocalDatabaseFallback,
  LocalDatabaseFallbackShape
>()("supabase/database/LocalDatabaseFallback") {}
