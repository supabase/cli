import type { Effect, Option } from "effect";
import { Context } from "effect";
import type { SchemaCheckpoint, SchemaDraftJournal } from "./schema-types.ts";
import type { SchemaCheckpointError, SchemaLockError } from "./schema-errors.ts";

interface SchemaStateStoreShape {
  readonly readCheckpoint: Effect.Effect<Option.Option<SchemaCheckpoint>, SchemaCheckpointError>;
  readonly writeCheckpoint: (
    checkpoint: SchemaCheckpoint,
  ) => Effect.Effect<void, SchemaCheckpointError>;
  readonly readJournal: Effect.Effect<Option.Option<SchemaDraftJournal>, SchemaCheckpointError>;
  readonly writeJournal: (
    journal: SchemaDraftJournal,
  ) => Effect.Effect<void, SchemaCheckpointError>;
  readonly clearJournal: Effect.Effect<void, SchemaCheckpointError>;
  readonly withLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SchemaLockError, R>;
}

export class SchemaStateStore extends Context.Service<SchemaStateStore, SchemaStateStoreShape>()(
  "supabase/schema/SchemaStateStore",
) {}
