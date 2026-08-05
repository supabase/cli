import type { ProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { StudioConfig } from "@supabase/stack/effect";
import { environmentOverride } from "./data-plane-stack-config-values.ts";

export function resolveStudioStackConfig(input: {
  readonly config: ProjectConfig["studio"];
  readonly environment: ProjectEnvironment | null;
  readonly base: StudioConfig | false | undefined;
}): StudioConfig | false {
  const openAiApiKey = environmentOverride(
    "SUPABASE_STUDIO_OPENAI_API_KEY",
    input.config.openai_api_key,
    input.environment,
  );
  return input.base === false ? false : { ...input.base, openAiApiKey };
}
