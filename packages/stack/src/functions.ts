import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  inferFunctionsManifest,
  loadProjectConfig,
  loadProjectEnvironment,
  resolveProjectSubtree,
  type ResolvedFunctionConfig,
} from "@supabase/config";
import { Effect, FileSystem, Path, Redacted } from "effect";
import type { ResolvedStackConfig } from "./StackBuilder.ts";

export interface FunctionsConfig {
  readonly envFile?: string;
  readonly noVerifyJwt?: boolean;
}

export interface ResolvedFunctionsConfig {
  readonly envFile?: string;
  readonly noVerifyJwt: boolean;
}

export interface FunctionsRuntimeConfig {
  readonly functionsUrl: string;
  readonly supabaseUrl: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly jwtSecret: string;
  readonly env: Readonly<Record<string, string>>;
  readonly functions: Readonly<
    Record<
      string,
      {
        readonly verifyJWT: boolean;
        readonly entrypointPath: string;
        readonly importMapPath: string;
        readonly staticFiles: ReadonlyArray<string>;
      }
    >
  >;
}

interface FunctionsRuntimeHost {
  readonly hostname: string;
}

export const functionsRuntimeConfigFileName = "functions-runtime-config.json";

function edgeRuntimeWorkspaceDir(runtimeRoot: string): string {
  return join(runtimeRoot, "edge-runtime");
}

export function functionsRuntimeConfigPath(runtimeRoot: string): string {
  return join(edgeRuntimeWorkspaceDir(runtimeRoot), functionsRuntimeConfigFileName);
}

function reveal(value: string | Redacted.Redacted<string>): string {
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
}

function absolutizeProjectPath(projectDir: string, relativePath: string): string {
  if (relativePath.length === 0) {
    return "";
  }

  const withoutDotSlash = relativePath.startsWith("./") ? relativePath.slice(2) : relativePath;
  return isAbsolute(withoutDotSlash)
    ? withoutDotSlash
    : join(projectDir, "supabase", withoutDotSlash);
}

function parseDotEnv(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = contents.replace(/\r\n?/g, "\n").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const equals = line.indexOf("=");
    if (equals === -1) {
      continue;
    }

    const key = line
      .slice(0, equals)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(equals + 1).trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'" || quote === "`") &&
      value.endsWith(quote) &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
    }
    if (quote === '"') {
      value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    }
    env[key] = value;
  }

  return env;
}

function loadEnvFile(path: string): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const resolveFunctionsProjectConfig = Effect.fnUntraced(function* (projectDir: string) {
  const projectEnv = yield* loadProjectEnvironment({ cwd: projectDir, baseEnv: process.env });
  const loadedConfig = yield* loadProjectConfig(projectDir);
  if (projectEnv === null || loadedConfig === null) {
    return undefined;
  }

  const resolvedFunctions = yield* resolveProjectSubtree(
    loadedConfig.config.functions,
    projectEnv,
    "functions",
  );

  return {
    ...loadedConfig.config,
    functions: Object.fromEntries(
      Object.entries(resolvedFunctions).map(([slug, config]) => [
        slug,
        {
          ...config,
          entrypoint: reveal(config.entrypoint),
          import_map: reveal(config.import_map),
          static_files: config.static_files.map((path) => reveal(path)),
          env: Object.fromEntries(
            Object.entries(config.env).map(([name, value]) => [name, reveal(value)]),
          ),
        },
      ]),
    ),
  };
});

function functionToRuntimeConfig(
  projectDir: string,
  noVerifyJwt: boolean,
  config: ResolvedFunctionConfig,
) {
  return {
    verifyJWT: noVerifyJwt ? false : config.verify_jwt,
    entrypointPath: absolutizeProjectPath(projectDir, config.entrypoint),
    importMapPath: absolutizeProjectPath(projectDir, config.import_map),
    staticFiles: config.static_files.map((path) => absolutizeProjectPath(projectDir, path)),
  };
}

export const resolveFunctionsRuntimeConfig = Effect.fnUntraced(function* (
  stackConfig: ResolvedStackConfig,
  runtimeHost: FunctionsRuntimeHost,
) {
  const functionsConfig = stackConfig.functions;
  if (functionsConfig === false || stackConfig.edgeRuntime === false) {
    return undefined;
  }

  const projectConfig = yield* resolveFunctionsProjectConfig(stackConfig.projectDir);
  const manifest = yield* inferFunctionsManifest({
    cwd: stackConfig.projectDir,
    ...(projectConfig === undefined ? {} : { config: projectConfig }),
  });
  const enabledManifest = Object.entries(manifest).filter(([, config]) => config.enabled);
  if (enabledManifest.length === 0) {
    return undefined;
  }

  const functionEnv = Object.fromEntries(
    enabledManifest.flatMap(([, config]) => Object.entries(config.env)),
  );
  const envFilePath =
    functionsConfig.envFile === undefined
      ? join(stackConfig.projectDir, "supabase", "functions", ".env")
      : resolve(stackConfig.projectDir, functionsConfig.envFile);
  const env = {
    ...loadEnvFile(envFilePath),
    ...functionEnv,
  };

  return {
    functionsUrl: `http://127.0.0.1:${stackConfig.apiPort}/functions/v1`,
    supabaseUrl: `http://${runtimeHost.hostname}:${stackConfig.apiPort}`,
    dbUrl: `postgresql://postgres:postgres@${runtimeHost.hostname}:${stackConfig.dbPort}/postgres`,
    publishableKey: stackConfig.publishableKey,
    secretKey: stackConfig.secretKey,
    jwtSecret: stackConfig.jwtSecret,
    env,
    functions: Object.fromEntries(
      enabledManifest.map(([slug, config]) => [
        slug,
        functionToRuntimeConfig(stackConfig.projectDir, functionsConfig.noVerifyJwt, config),
      ]),
    ),
  } satisfies FunctionsRuntimeConfig;
});

const writeFunctionsRuntimeConfig = Effect.fnUntraced(function* (
  runtimeRoot: string,
  config: FunctionsRuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = functionsRuntimeConfigPath(runtimeRoot);
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, `${JSON.stringify(config, null, 2)}\n`);
});

const clearFunctionsRuntimeConfig = Effect.fnUntraced(function* (runtimeRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(functionsRuntimeConfigPath(runtimeRoot)).pipe(Effect.ignore);
});

export const configureFunctionsRuntime = Effect.fnUntraced(function* (
  stackConfig: ResolvedStackConfig,
  runtimeHost: FunctionsRuntimeHost,
) {
  const runtimeConfig = yield* resolveFunctionsRuntimeConfig(stackConfig, runtimeHost);
  if (runtimeConfig === undefined) {
    yield* clearFunctionsRuntimeConfig(stackConfig.runtimeRoot);
  } else {
    yield* writeFunctionsRuntimeConfig(stackConfig.runtimeRoot, runtimeConfig);
  }
  return runtimeConfig;
});
