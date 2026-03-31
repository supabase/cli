import type { Effect, Option } from "effect";
import { Data, Schema, ServiceMap } from "effect";

export const LinkedServiceVersionsSchema = Schema.Struct({
  postgres: Schema.optionalKey(Schema.String),
  postgrest: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.String),
  storage: Schema.optionalKey(Schema.String),
});

export type LinkedServiceVersions = Schema.Schema.Type<typeof LinkedServiceVersionsSchema>;

export const ProjectLinkStateValueSchema = Schema.Struct({
  ref: Schema.String,
  name: Schema.optionalKey(Schema.String),
  organization_id: Schema.optionalKey(Schema.String),
  organization_slug: Schema.optionalKey(Schema.String),
  fetchedAt: Schema.String,
  versions: LinkedServiceVersionsSchema,
});

export type ProjectLinkStateValue = Schema.Schema.Type<typeof ProjectLinkStateValueSchema>;

export class InvalidProjectLinkStateError extends Data.TaggedError("InvalidProjectLinkStateError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {}

interface ProjectLinkStateShape {
  readonly load: Effect.Effect<Option.Option<ProjectLinkStateValue>, InvalidProjectLinkStateError>;
  readonly save: (state: ProjectLinkStateValue) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export class ProjectLinkState extends ServiceMap.Service<ProjectLinkState, ProjectLinkStateShape>()(
  "@supabase/cli/config/ProjectLinkState",
) {}
