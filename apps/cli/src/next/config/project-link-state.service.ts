import type { Effect, Option } from "effect";
import { Data, Schema, ServiceMap } from "effect";

export const LinkedServiceVersionsSchema = Schema.Struct({
  postgres: Schema.optionalKey(Schema.String),
  postgrest: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.String),
  storage: Schema.optionalKey(Schema.String),
});

export type LinkedServiceVersions = Schema.Schema.Type<typeof LinkedServiceVersionsSchema>;

export const ActiveBranchSchema = Schema.Struct({
  ref: Schema.String,
  name: Schema.String,
  is_default: Schema.Boolean,
});

export type ActiveBranch = Schema.Schema.Type<typeof ActiveBranchSchema>;

const ProjectSchema = Schema.Struct({
  ref: Schema.String,
  name: Schema.String,
  organization_id: Schema.String,
  organization_slug: Schema.String,
});

export const ProjectLinkStateValueSchema = Schema.Struct({
  project: ProjectSchema,
  active_branch: ActiveBranchSchema,
  fetchedAt: Schema.String,
  versions: LinkedServiceVersionsSchema,
});

export type ProjectLinkStateValue = Schema.Schema.Type<typeof ProjectLinkStateValueSchema>;

export class InvalidProjectLinkStateError extends Data.TaggedError("InvalidProjectLinkStateError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {}

export class ProjectNotLinkedError extends Data.TaggedError("ProjectNotLinkedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {}

interface ProjectLinkStateShape {
  readonly load: Effect.Effect<Option.Option<ProjectLinkStateValue>, InvalidProjectLinkStateError>;
  readonly save: (state: ProjectLinkStateValue) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  readonly getActiveBranch: Effect.Effect<
    Option.Option<ActiveBranch>,
    InvalidProjectLinkStateError
  >;
  readonly setActiveBranch: (
    branch: ActiveBranch,
  ) => Effect.Effect<void, InvalidProjectLinkStateError | ProjectNotLinkedError>;
}

export class ProjectLinkState extends ServiceMap.Service<ProjectLinkState, ProjectLinkStateShape>()(
  "supabase/config/ProjectLinkState",
) {}
