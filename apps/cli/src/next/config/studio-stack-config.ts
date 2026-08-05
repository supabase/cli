import type { LoadedProjectConfig, ProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { StudioConfig } from "@supabase/stack/effect";
import { environmentOverride } from "./data-plane-stack-config-values.ts";

export function resolveStudioStackConfig(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly config: ProjectConfig["studio"];
  readonly environment: ProjectEnvironment | null;
  readonly base: StudioConfig | false | undefined;
}): StudioConfig | false {
  const openAiApiKey = environmentOverride(
    "studio.openai_api_key",
    input.config.openai_api_key,
    input.environment,
    input.loaded,
  );
  return input.base === false ? false : { ...input.base, openAiApiKey };
}
