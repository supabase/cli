import type { Effect } from "effect";
import { ServiceMap } from "effect";

interface ProjectHomeShape {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly projectHomeDir: string;
  readonly projectLinkPath: string;
  readonly projectLocalVersionsPath: string;
  readonly ensureProjectHomeDir: Effect.Effect<void>;
  readonly stackDir: (name: string) => string;
  readonly stackStatePath: (name: string) => string;
  readonly stackMetadataPath: (name: string) => string;
  readonly stackDataDir: (name: string) => string;
  readonly stackLogsDir: (name: string) => string;
}

export class ProjectHome extends ServiceMap.Service<ProjectHome, ProjectHomeShape>()(
  "supabase/config/ProjectHome",
) {}
