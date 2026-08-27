import type { Effect, Option } from "effect";
import { Context } from "effect";
import type { SchemaDraftJournal } from "./schema-types.ts";
import type { SchemaLockError, SchemaStateError } from "./schema-errors.ts";

interface SchemaStateStoreShape {
  readonly readJournal: Effect.Effect<Option.Option<SchemaDraftJournal>, SchemaStateError>;
  readonly writeJournal: (journal: SchemaDraftJournal) => Effect.Effect<void, SchemaStateError>;
  readonly clearJournal: Effect.Effect<void, SchemaStateError>;
  readonly withLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SchemaLockError, R>;
}

export class SchemaStateStore extends Context.Service<SchemaStateStore, SchemaStateStoreShape>()(
  "supabase/schema/SchemaStateStore",
) {}
