import type { Effect } from "effect";
import { Context } from "effect";
import type {
  LoadedProjectConfig,
  LoadProjectConfigOptions,
  SaveProjectConfigOptions,
} from "./io.ts";

interface ProjectConfigStoreShape {
  readonly load: (
    cwd: string,
    options?: LoadProjectConfigOptions,
  ) => Effect.Effect<LoadedProjectConfig | null, unknown>;
  readonly loadFile: (path: string) => Effect.Effect<LoadedProjectConfig, unknown>;
  readonly save: (options: SaveProjectConfigOptions) => Effect.Effect<LoadedProjectConfig, unknown>;
}

export class ProjectConfigStore extends Context.Service<
  ProjectConfigStore,
  ProjectConfigStoreShape
>()("@supabase/config/ProjectConfigStore") {}
