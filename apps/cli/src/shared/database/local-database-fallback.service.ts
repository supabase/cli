import { Context, Effect, Layer, Option } from "effect";
import type { SchemaLocalStackNotRunningError } from "../schema/schema-errors.ts";
import type { DatabaseTarget } from "./database-target.ts";

interface LocalDatabaseFallbackShape {
  readonly resolve: Effect.Effect<Option.Option<DatabaseTarget>, SchemaLocalStackNotRunningError>;
}

/**
 * Optional project-owned local DB when the native stack is not recorded.
 * Used by the stable shell to see a Docker `supabase start` for *this* project.
 * Absent on next, which only has native stack state.
 */
export class LocalDatabaseFallback extends Context.Service<
  LocalDatabaseFallback,
  LocalDatabaseFallbackShape
>()("supabase/database/LocalDatabaseFallback") {}

export const noLocalDatabaseFallbackLayer = Layer.succeed(LocalDatabaseFallback, {
  resolve: Effect.succeed(Option.none()),
});
