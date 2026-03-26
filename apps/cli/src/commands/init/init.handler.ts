import { dirname } from "node:path";
import {
  PROJECT_CONFIG_SCHEMA_URL,
  ProjectConfigSchema,
  ProjectConfigStore,
} from "@supabase/config";
import { Effect } from "effect";
import { Schema } from "effect";
import { ensureProjectStateIgnored } from "../../config/project-gitignore.ts";
import { Output } from "../../output/output.service.ts";
import { RuntimeInfo } from "../../runtime/runtime-info.service.ts";

const emptyConfig = Schema.decodeUnknownSync(ProjectConfigSchema)({});
const projectRootForConfigPath = (configPath: string): string => dirname(dirname(configPath));

export const init = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const runtimeInfo = yield* RuntimeInfo;
  const projectConfigStore = yield* ProjectConfigStore;

  yield* output.intro("Initialize local Supabase project");

  const existingConfig = yield* projectConfigStore.load(runtimeInfo.cwd);
  if (existingConfig !== null) {
    yield* ensureProjectStateIgnored(projectRootForConfigPath(existingConfig.path));
    yield* output.success("Supabase project already initialized.", {
      config_path: existingConfig.path,
      schema_ref: existingConfig.schemaRef,
      created: false,
    });
    yield* output.outro(`Using existing config at ${existingConfig.path}.`);
    return;
  }

  const saved = yield* projectConfigStore.save({
    cwd: runtimeInfo.cwd,
    config: emptyConfig,
    format: "json",
    schemaRef: PROJECT_CONFIG_SCHEMA_URL,
  });
  yield* ensureProjectStateIgnored(projectRootForConfigPath(saved.path));

  yield* output.success("Initialized Supabase project.", {
    config_path: saved.path,
    schema_ref: saved.schemaRef,
    created: true,
  });
  yield* output.outro(`Created ${saved.path}.`);
});
