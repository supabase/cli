import { isAbsolute, join } from "node:path";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { ResolvedStackConfig } from "./StackConfig.ts";

const absolutePath = Schema.String.check(
  Schema.makeFilter((value) =>
    isAbsolute(value) ? undefined : { path: [], issue: "Expected an absolute path" },
  ),
);

const environment = Schema.Record(Schema.String, Schema.String);

export const ResolvedFunctionSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  verifyJWT: Schema.Boolean,
  entrypointPath: absolutePath,
  importMapPath: Schema.NullOr(absolutePath),
  staticFiles: Schema.Array(absolutePath),
  env: environment,
});

export interface ResolvedFunction extends Schema.Schema.Type<typeof ResolvedFunctionSchema> {}

/**
 * Project-owned Edge Functions input. Every path and environment reference is
 * resolved before the bundle crosses into the stack package.
 *
 * `env` contains values shared by every function. A function's own `env`
 * overrides matching shared values when its worker is created.
 */
export const ResolvedFunctionsBundleSchema = Schema.Struct({
  env: environment,
  functions: Schema.Array(ResolvedFunctionSchema),
}).check(
  Schema.makeFilter((bundle) => {
    const names = new Set<string>();
    for (let index = 0; index < bundle.functions.length; index += 1) {
      const name = bundle.functions[index]?.name;
      if (name !== undefined && names.has(name)) {
        return {
          path: ["functions", index, "name"],
          issue: `Duplicate function name: ${name}`,
        };
      }
      if (name !== undefined) {
        names.add(name);
      }
    }
    return undefined;
  }),
);

export interface ResolvedFunctionsBundle extends Schema.Schema.Type<
  typeof ResolvedFunctionsBundleSchema
> {}

export const FunctionsConfigureConfigSchema = Schema.Struct({
  functions: Schema.optionalKey(ResolvedFunctionsBundleSchema),
});

export interface FunctionsConfigureConfig extends Schema.Schema.Type<
  typeof FunctionsConfigureConfigSchema
> {}

export const FunctionsReloadConfigSchema = Schema.Struct({
  functions: Schema.optionalKey(ResolvedFunctionsBundleSchema),
});

export interface FunctionsReloadConfig extends FunctionsConfigureConfig {}

export interface FunctionsRuntimeConfig {
  readonly functionsUrl: string;
  readonly supabaseUrl: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  /** Internal verifier set. It may contain symmetric secret material and is never public output. */
  readonly verificationJwks: string;
  readonly env: Readonly<Record<string, string>>;
  readonly functions: Readonly<
    Record<
      string,
      {
        readonly verifyJWT: boolean;
        readonly entrypointPath: string;
        readonly importMapPath: string | null;
        readonly staticFiles: ReadonlyArray<string>;
        readonly env: Readonly<Record<string, string>>;
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

export function resolveFunctionsRuntimeConfig(
  stackConfig: ResolvedStackConfig,
  runtimeHost: FunctionsRuntimeHost,
  bundle: ResolvedFunctionsBundle | undefined,
): FunctionsRuntimeConfig | undefined {
  if (bundle === undefined || bundle.functions.length === 0 || stackConfig.edgeRuntime === false) {
    return undefined;
  }

  return {
    functionsUrl: `http://127.0.0.1:${stackConfig.apiPort}/functions/v1`,
    supabaseUrl: `http://${runtimeHost.hostname}:${stackConfig.apiPort}`,
    dbUrl: `postgresql://postgres:postgres@${runtimeHost.hostname}:${stackConfig.dbPort}/postgres`,
    publishableKey: stackConfig.publishableKey,
    secretKey: stackConfig.secretKey,
    verificationJwks: stackConfig.credentials.jwks,
    env: bundle.env,
    functions: Object.fromEntries(
      bundle.functions.map((fn) => [
        fn.name,
        {
          verifyJWT: fn.verifyJWT,
          entrypointPath: fn.entrypointPath,
          importMapPath: fn.importMapPath,
          staticFiles: fn.staticFiles,
          env: fn.env,
        },
      ]),
    ),
  };
}

const writeFunctionsRuntimeConfig = Effect.fnUntraced(function* (
  runtimeRoot: string,
  config: FunctionsRuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = functionsRuntimeConfigPath(runtimeRoot);
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.tmp-${crypto.randomUUID()}`;

  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    yield* fs.chmod(temporaryPath, 0o600);
    yield* fs.rename(temporaryPath, filePath);
    yield* fs.chmod(filePath, 0o600);
  }).pipe(Effect.ensuring(fs.remove(temporaryPath).pipe(Effect.ignore)));
});

export const clearFunctionsRuntimeConfig = Effect.fnUntraced(function* (runtimeRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = functionsRuntimeConfigPath(runtimeRoot);
  const directory = yield* Path.Path.pipe(Effect.map((path) => path.dirname(filePath)));

  yield* fs.remove(filePath).pipe(Effect.ignore);

  const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    entries.filter((entry) => entry.startsWith(`${functionsRuntimeConfigFileName}.tmp-`)),
    (entry) => fs.remove(join(directory, entry)).pipe(Effect.ignore),
    { discard: true },
  );
});

export const configureFunctionsRuntime = Effect.fnUntraced(function* (
  stackConfig: ResolvedStackConfig,
  runtimeHost: FunctionsRuntimeHost,
  bundle: ResolvedFunctionsBundle | undefined,
) {
  const runtimeConfig = resolveFunctionsRuntimeConfig(stackConfig, runtimeHost, bundle);
  if (runtimeConfig === undefined) {
    yield* clearFunctionsRuntimeConfig(stackConfig.runtimeRoot);
  } else {
    yield* writeFunctionsRuntimeConfig(stackConfig.runtimeRoot, runtimeConfig);
  }
  return runtimeConfig;
});
