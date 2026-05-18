import type { ProjectConfig, ProjectEnvironment, ProjectPaths } from "@supabase/config";
import type { Option } from "effect";
import { Context } from "effect";

interface ProjectContextShape {
  readonly paths: Option.Option<ProjectPaths>;
  readonly projectEnv: Option.Option<ProjectEnvironment>;
  readonly rawProjectConfig: Option.Option<ProjectConfig>;
}

export class ProjectContext extends Context.Service<ProjectContext, ProjectContextShape>()(
  "supabase/config/ProjectContext",
) {}
