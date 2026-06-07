import type { Effect, Option } from "effect";
import { Data, Schema, Context } from "effect";

const LocalServiceVersionsSchema = Schema.Struct({
  postgres: Schema.optionalKey(Schema.String),
  postgrest: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.String),
  realtime: Schema.optionalKey(Schema.String),
  storage: Schema.optionalKey(Schema.String),
  imgproxy: Schema.optionalKey(Schema.String),
  mailpit: Schema.optionalKey(Schema.String),
  pgmeta: Schema.optionalKey(Schema.String),
  studio: Schema.optionalKey(Schema.String),
  analytics: Schema.optionalKey(Schema.String),
  vector: Schema.optionalKey(Schema.String),
  pooler: Schema.optionalKey(Schema.String),
});

export const LocalServiceVersionsStateSchema = Schema.Struct({
  updatedAt: Schema.String,
  versions: LocalServiceVersionsSchema,
});

export type LocalServiceVersionsState = Schema.Schema.Type<typeof LocalServiceVersionsStateSchema>;

export class InvalidLocalServiceVersionsStateError extends Data.TaggedError(
  "InvalidLocalServiceVersionsStateError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {}

interface ProjectLocalServiceVersionsShape {
  readonly load: Effect.Effect<
    Option.Option<LocalServiceVersionsState>,
    InvalidLocalServiceVersionsStateError
  >;
}

export class ProjectLocalServiceVersions extends Context.Service<
  ProjectLocalServiceVersions,
  ProjectLocalServiceVersionsShape
>()("supabase/config/ProjectLocalServiceVersions") {}
