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

const runtimePath = (path: Path.Path, value: string): string => value.replaceAll(path.sep, "/");

const resolveFlagPath = (path: Path.Path, value: string, cwd: string): string =>
  path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);

interface ExplicitImportMap {
  readonly runtimePath: string;
  readonly sourcePath: string;
}

const explicitImportMap = (
  value: string,
  projectRoot: string,
  cwd: string,
): Effect.Effect<ExplicitImportMap, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const sourcePath = resolveFlagPath(path, value, cwd);
    const functionsRoot = path.join(projectRoot, "supabase", "functions");
    const relative = path.relative(functionsRoot, sourcePath);
    const contained =
      !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
    return {
      runtimePath: runtimePath(path, contained ? relative : sourcePath),
      sourcePath,
    };
  });

interface ExplicitEnvironment {
  readonly environment: Readonly<Record<string, Redacted.Redacted<string>>>;
  readonly path: string;
}

const readExplicitEnvironment = (
  value: string,
  cwd: string,
): Effect.Effect<
  ExplicitEnvironment,
  StackFunctionsServeError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pathname = resolveFlagPath(path, value, cwd);
    const contents = yield* fs
      .readFileString(pathname)
      .pipe(Effect.mapError((cause) => configError(`Unable to read env file ${pathname}`, cause)));
    const values = yield* Effect.try({
      try: () => parseDotEnv(contents),
      catch: (cause) => configError(`Unable to parse env file ${pathname}`, cause),
    });
    return {
      environment: Object.fromEntries(
        Object.entries(values).map(([key, item]) => [key, Redacted.make(item)]),
      ),
      path: pathname,
    };
  });

export interface FunctionsServeStackConfigResult {
  readonly config: StackConfig;
  /** Legacy-compatible diagnostics that the handler writes to stderr. */
  readonly warnings: ReadonlyArray<string>;
  /** Absolute flag-derived files that restart the serve session when changed. */
  readonly watchPaths: ReadonlyArray<string>;
  /** Absolute caller-owned import map path used to prepare native and container runtimes. */
  readonly importMapSource?: string;
}

export const functionsServeStackConfig = (input: {
  readonly config: StackConfig;
  readonly flags: FunctionsServeFlags;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly debug: boolean;
}): Effect.Effect<
  FunctionsServeStackConfigResult,
  StackFunctionsServeError,
  FileSystem.FileSystem | Path.Path
> =>
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
    const warnings: string[] = [];
    const watchPaths: string[] = [];
    let importMapSource: string | undefined;

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
      importMapSource = resolved.sourcePath;
      watchPaths.push(resolved.sourcePath);
      edgeRuntime = { ...edgeRuntime, import_map_default: resolved.runtimePath };
      const functionsRoot = path.join(input.projectRoot, "supabase", "functions");
      functions = Object.fromEntries(
        Object.entries(functions).map(([name, value]) => [
          name,
          {
            ...value,
            import_map: runtimePath(
              path,
              path.relative(path.join(functionsRoot, name), resolved.sourcePath),
            ),
          },
        ]),
      );
    }

    if (Option.isSome(input.flags.envFile)) {
      const explicit = yield* readExplicitEnvironment(input.flags.envFile.value, input.cwd);
      watchPaths.push(explicit.path);
      edgeRuntime = {
        ...edgeRuntime,
        secrets: { ...edgeRuntime.secrets, ...explicit.environment },
      };
    }

    if (edgeRuntime.secrets !== undefined) {
      edgeRuntime = {
        ...edgeRuntime,
        secrets: Object.fromEntries(
          Object.entries(edgeRuntime.secrets).filter(([name]) => {
            if (!name.startsWith("SUPABASE_")) return true;
            warnings.push(`Env name cannot start with SUPABASE_, skipping: ${name}\n`);
            return false;
          }),
        ),
      };
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
      config: {
        ...input.config,
        capabilities: {
          ...input.config.capabilities,
          functions: {
            ...capability,
            settings,
          },
        },
      },
      warnings,
      watchPaths,
      ...(importMapSource === undefined ? {} : { importMapSource }),
    };
  });
