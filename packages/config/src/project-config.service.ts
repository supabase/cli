import { Context, Data, type Effect } from "effect";
import type {
  LoadedProjectConfig,
  LoadProjectConfigOptions,
  SaveProjectConfigOptions,
} from "./io.ts";

export class ProjectConfigStoreError extends Data.TaggedError("ProjectConfigStoreError")<{
  readonly operation: "load" | "loadFile" | "save";
  readonly cause: unknown;
}> {}

interface ProjectConfigStoreShape {
  readonly load: (
    cwd: string,
    options?: LoadProjectConfigOptions,
  ) => Effect.Effect<LoadedProjectConfig | null, ProjectConfigStoreError>;
  readonly loadFile: (path: string) => Effect.Effect<LoadedProjectConfig, ProjectConfigStoreError>;
  readonly save: (
    options: SaveProjectConfigOptions,
  ) => Effect.Effect<LoadedProjectConfig, ProjectConfigStoreError>;
}

export class ProjectConfigStore extends Context.Service<
  ProjectConfigStore,
  ProjectConfigStoreShape
>()("@supabase/config/ProjectConfigStore") {}
