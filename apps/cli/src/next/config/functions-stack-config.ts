import {
  inferFunctionsManifest,
  loadDotEnvFile,
  ProjectConfigSchema,
  resolveProjectSubtree,
  type FunctionsManifest,
  type LoadedProjectConfig,
  type ProjectConfig,
  type ProjectEnvironment,
} from "@supabase/config";
import type { ResolvedFunctionsBundle } from "@supabase/stack/effect";
import { Effect, Redacted, Schema } from "effect";
import { resolve } from "node:path";

const decodeDefaultProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
const defaultProjectConfig = decodeDefaultProjectConfig({});

interface ProjectFunctionsInput {
  readonly loadedProjectConfig: LoadedProjectConfig | null;
  readonly projectEnvironment: Pick<ProjectEnvironment, "values"> | null;
  readonly projectRoot: string;
  readonly configDir: string;
  readonly envFilePath: string;
}

export interface FunctionsDevStackConfigInput extends ProjectFunctionsInput {
  readonly noVerifyJwt: boolean;
}

export type StartFunctionsStackConfigInput = ProjectFunctionsInput;

function reveal(value: string | Redacted.Redacted<string>): string {
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
}

function absoluteConfigPath(configDir: string, path: string): string {
  return resolve(configDir, path.startsWith("./") ? path.slice(2) : path);
}

const resolveProjectFunctions = Effect.fnUntraced(function* (input: ProjectFunctionsInput) {
  const projectConfig = input.loadedProjectConfig?.config ?? defaultProjectConfig;
  const environment = input.projectEnvironment ?? { values: {} };
  const resolved = yield* resolveProjectSubtree(projectConfig.functions, environment, "functions");
  const functions: ProjectConfig["functions"] = Object.fromEntries(
    Object.entries(resolved).map(([name, config]) => [
      name,
      {
        ...config,
        entrypoint: reveal(config.entrypoint),
        import_map: reveal(config.import_map),
        static_files: config.static_files.map(reveal),
        env: Object.fromEntries(
          Object.entries(config.env).map(([key, value]) => [key, reveal(value)]),
        ),
      },
    ]),
  );
  const manifest = yield* inferFunctionsManifest({
    cwd: input.projectRoot,
    config: { ...projectConfig, functions },
  });

  return { manifest, projectConfig, environment };
});

const makeFunctionsBundle = Effect.fnUntraced(function* (
  input: ProjectFunctionsInput,
  manifest: FunctionsManifest,
  sharedEnv: Readonly<Record<string, string>>,
  noVerifyJwt: boolean,
) {
  const env = { ...sharedEnv, ...(yield* loadDotEnvFile(input.envFilePath)) };

  return {
    env,
    functions: Object.entries(manifest)
      .filter(([, config]) => config.enabled)
      .map(([name, config]) => ({
        name,
        verifyJWT: noVerifyJwt ? false : config.verify_jwt,
        entrypointPath: absoluteConfigPath(input.configDir, config.entrypoint),
        importMapPath:
          config.import_map === "" ? null : absoluteConfigPath(input.configDir, config.import_map),
        staticFiles: config.static_files.map((path) => absoluteConfigPath(input.configDir, path)),
        env: config.env,
      })),
  } satisfies ResolvedFunctionsBundle;
});

/** Resolve the standalone functions-dev bundle without adding project Edge Runtime secrets. */
export const translateFunctionsDevStackConfig = Effect.fnUntraced(function* (
  input: FunctionsDevStackConfigInput,
) {
  const { manifest } = yield* resolveProjectFunctions(input);
  return yield* makeFunctionsBundle(input, manifest, {}, input.noVerifyJwt);
});

/**
 * Resolve the ordinary start bundle. Project Edge Runtime secrets form the
 * lowest-precedence shared environment; `functions/.env` overrides them.
 */
export const translateStartFunctionsStackConfig = Effect.fnUntraced(function* (
  input: StartFunctionsStackConfigInput,
) {
  const { manifest, projectConfig, environment } = yield* resolveProjectFunctions(input);
  const edgeRuntime = yield* resolveProjectSubtree(
    projectConfig.edge_runtime,
    environment,
    "edge_runtime",
  );
  const edgeRuntimeSecrets = Object.fromEntries(
    Object.entries(edgeRuntime.secrets ?? {}).flatMap(([name, value]) =>
      Redacted.isRedacted(value) && Redacted.value(value).length > 0
        ? [[name.toUpperCase(), Redacted.value(value)] as const]
        : [],
    ),
  );

  return yield* makeFunctionsBundle(input, manifest, edgeRuntimeSecrets, false);
});
