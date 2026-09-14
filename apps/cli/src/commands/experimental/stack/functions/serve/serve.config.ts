import type { FunctionsSettings, StackConfig } from "@supabase/stack/effect";
import { Effect, FileSystem, Option, Path, Redacted } from "effect";
import { parseDotEnv } from "../../../../../command-internal/dotenv.ts";
import {
  buildFunctionsServeInspectArgs,
  resolveFunctionsServeInspectMode,
  type FunctionsServeFlags,
} from "../../../../../shared/functions/serve.ts";
import { StackFunctionsServeError } from "./serve.errors.ts";

const configError = (message: string, cause?: unknown) =>
  new StackFunctionsServeError({ reason: "invalid-config", message, cause });

const runtimePath = (path: Path.Path, value: string): string =>
  value.replaceAll(path.sep, "/");

const explicitImportMap = (
  value: string,
  projectRoot: string,
  cwd: string,
): Effect.Effect<
  string,
  StackFunctionsServeError,
  Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
    const functionsRoot = path.join(projectRoot, "supabase", "functions");
    const relative = path.relative(functionsRoot, absolute);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      return yield* configError("--import-map must resolve inside supabase/functions");
    return runtimePath(path, relative);
  });

const readExplicitEnvironment = (
  value: string,
  cwd: string,
): Effect.Effect<
  Readonly<Record<string, Redacted.Redacted<string>>>,
  StackFunctionsServeError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pathname = path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
    const contents = yield* fs
      .readFileString(pathname)
      .pipe(Effect.mapError((cause) => configError(`Unable to read env file ${pathname}`, cause)));
    const values = yield* Effect.try({
      try: () => parseDotEnv(contents),
      catch: (cause) => configError(`Unable to parse env file ${pathname}`, cause),
    });
    return Object.fromEntries(
      Object.entries(values).map(([key, item]) => [key, Redacted.make(item)]),
    );
  });

export const functionsServeStackConfig = (input: {
  readonly config: StackConfig;
  readonly flags: FunctionsServeFlags;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly debug: boolean;
}): Effect.Effect<StackConfig, StackFunctionsServeError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const capability = input.config.capabilities?.functions;
    if (capability?.enabled === false)
      return yield* configError("Edge Functions are disabled in supabase/config.toml");

    const currentSettings = capability?.settings ?? {};
    let functions: NonNullable<FunctionsSettings["functions"]> = {
      ...currentSettings.functions,
    };
    let edgeRuntime: NonNullable<FunctionsSettings["edge_runtime"]> = {
      ...currentSettings.edge_runtime,
    };

    if (Option.isSome(input.flags.noVerifyJwt)) {
      const verifyJwt = !input.flags.noVerifyJwt.value;
      edgeRuntime = { ...edgeRuntime, verify_jwt_default: verifyJwt };
      functions = Object.fromEntries(
        Object.entries(functions).map(([name, value]) => [
          name,
          { ...value, verify_jwt: verifyJwt },
        ]),
      );
    }

    if (Option.isSome(input.flags.importMap)) {
      const path = yield* Path.Path;
      const resolved = yield* explicitImportMap(
        input.flags.importMap.value,
        input.projectRoot,
        input.cwd,
      );
      edgeRuntime = { ...edgeRuntime, import_map_default: resolved };
      const functionsRoot = path.join(input.projectRoot, "supabase", "functions");
      const absolute = path.isAbsolute(input.flags.importMap.value)
        ? path.normalize(input.flags.importMap.value)
        : path.resolve(input.cwd, input.flags.importMap.value);
      functions = Object.fromEntries(
        Object.entries(functions).map(([name, value]) => [
          name,
          {
            ...value,
            import_map: runtimePath(path, path.relative(path.join(functionsRoot, name), absolute)),
          },
        ]),
      );
    }

    if (Option.isSome(input.flags.envFile)) {
      const environment = yield* readExplicitEnvironment(input.flags.envFile.value, input.cwd);
      edgeRuntime = { ...edgeRuntime, secrets: environment };
      functions = Object.fromEntries(
        Object.entries(functions).map(([name, value]) => [name, { ...value, env: {} }]),
      );
    }

    const inspector = yield* Effect.try({
      try: () => {
        const mode = resolveFunctionsServeInspectMode(input.flags);
        buildFunctionsServeInspectArgs(mode, input.flags.inspectMain);
        return mode === undefined ? undefined : { mode, main: input.flags.inspectMain };
      },
      catch: (cause) =>
        new StackFunctionsServeError({
          reason: "flags",
          message: cause instanceof Error ? cause.message : "Invalid inspector flags",
          cause,
        }),
    });
    const settings: FunctionsSettings = {
      ...currentSettings,
      debug: input.debug,
      edge_runtime: edgeRuntime,
      ...(inspector === undefined ? {} : { inspector }),
      functions,
    };
    return {
      ...input.config,
      capabilities: {
        ...input.config.capabilities,
        functions: {
          ...capability,
          settings,
        },
      },
    };
  });
