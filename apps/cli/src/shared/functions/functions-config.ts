import { Data, Effect, FileSystem, Option, Path, Predicate, Redacted } from "effect";
import { Digest } from "effect/crypto";
import type { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import type { LoadedCliConfig } from "@supabase/config/effect";
import { CliConfigValues, type ResolvedCliConfig } from "../../config/cli-config-values.service.ts";
import { parseDotEnv } from "../config/dotenv.ts";
import { Output } from "../output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";
import { nativePlatformFailure } from "./functions-docker.ts";

type FunctionsLoadedConfig = Pick<LoadedCliConfig, "config" | "document">;

/**
 * Config resolution context shared by the `functions` Docker paths
 * (`deploy`, `download`, `serve`), produced by the injected
 * {@link FunctionsLocalConfigLoader}.
 */
interface FunctionsCliConfigContext {
  readonly loaded: FunctionsLoadedConfig;
  readonly resolvedConfig: ResolvedCliConfig;
  /** The config file's path; `undefined` when the project has none. */
  readonly configPath: string | undefined;
  /** Merged env with ambient values winning. */
  readonly projectEnvValues: Readonly<Record<string, string>>;
  /** Sanitized project id, resolved after config validation. */
  readonly projectId: string;
  readonly denoVersion: number | undefined;
}

/**
 * Hook that lets the shared `functions` modules run the command tree's config/dotenv
 * validation pipeline without importing that machinery directly.
 */
export interface FunctionsLocalConfigLoader {
  readonly load: (input: {
    readonly projectRoot: string;
    readonly projectRef: string | undefined;
  }) => Effect.Effect<
    {
      readonly loaded: FunctionsLoadedConfig;
      readonly resolvedConfig: ResolvedCliConfig;
      readonly configPath: string | undefined;
      readonly projectEnvValues: Readonly<Record<string, string>>;
      readonly projectId: string;
      readonly denoVersion: number;
    },
    Error,
    FileSystem.FileSystem | Path.Path | RuntimeInfo | Digest.Digest | CliConfigValues
  >;
}

/**
 * Loads project config for a `functions` command, running `localConfigLoader`'s
 * dotenv/config-validate pipeline before any Docker/API work.
 */
export const loadFunctionsCliConfig = Effect.fn("FunctionsConfig.load")(function* (input: {
  readonly projectRoot: string;
  readonly projectRef: string | undefined;
  readonly localConfigLoader: FunctionsLocalConfigLoader;
}) {
  const values = yield* CliConfigValues;
  // Loaded first so a config failure reaches the caller as its own typed error, not as the
  // validation hook's message-only wrapper; the hook's own load reuses this memoised resolved config.
  yield* values.load({
    workdir: input.projectRoot,
    projectRef: Option.fromNullishOr(input.projectRef),
  });

  const context = yield* input.localConfigLoader.load({
    projectRoot: input.projectRoot,
    projectRef: input.projectRef,
  });
  return {
    loaded: context.loaded,
    resolvedConfig: context.resolvedConfig,
    configPath: context.configPath,
    projectEnvValues: context.projectEnvValues,
    projectId: context.projectId,
    denoVersion: context.denoVersion,
  } satisfies FunctionsCliConfigContext;
});

/**
 * `[edge_runtime.secrets]` as the Functions container env: names uppercased, only resolved
 * non-empty values kept. An unresolved `env(VAR)` literal stays a plain string, not
 * `Redacted`, so it is dropped, the same guard `secrets set` uses.
 */
export function toEdgeRuntimeSecretsEnv(
  secrets: Readonly<Record<string, string | Redacted.Redacted<string> | undefined>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(secrets ?? {}).flatMap(([name, value]): Array<[string, string]> =>
      Redacted.isRedacted(value) && Redacted.value(value).length > 0
        ? [[name.toUpperCase(), Redacted.value(value)]]
        : [],
    ),
  );
}

/** A Functions env that cannot be read, parsed or decrypted. */
export class FunctionsEnvError extends Data.TaggedError("FunctionsEnvError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** The parse failure without the offending line, which may hold a secret. */
function dotEnvParseErrorMessage(path: string, cause: unknown) {
  if (!(cause instanceof Error)) {
    return `failed to parse environment file: ${path}`;
  }
  const message = cause.message;
  if (message.startsWith('unexpected character "')) {
    const prefix = 'unexpected character "';
    const start = message.indexOf(prefix);
    if (start !== -1) {
      const charStart = start + prefix.length;
      const charEnd = message.indexOf('"', charStart);
      if (charEnd !== -1) {
        const char = message.slice(charStart, charEnd);
        return `failed to parse environment file: ${path} (unexpected character '${char}' in variable name)`;
      }
    }
    return `failed to parse environment file: ${path} (unexpected character in variable name)`;
  }
  if (message.startsWith("unterminated quoted value")) {
    return `failed to parse environment file: ${path} (unterminated quoted value)`;
  }
  if (message.includes("\n")) {
    return `failed to parse environment file: ${path} (syntax error)`;
  }
  return `failed to load ${path}: ${message}`;
}

/* Native UTF-8 reads retain a leading BOM, which JSON and dotenv parsers reject. */
export const readFileUtf8 = (fs: FileSystem.FileSystem, pathname: string) =>
  fs.readFile(pathname).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("utf8")));

const readFunctionsEnvFile = Effect.fnUntraced(function* (pathname: string, optional: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* readFileUtf8(fs, pathname).pipe(
    Effect.catch((error) => {
      if (optional && Predicate.isTagged(error.reason, "NotFound")) return Effect.succeed("");
      const failure = nativePlatformFailure(error, pathname);
      return Effect.fail(
        new FunctionsEnvError({
          message: `failed to load environment file: ${pathname} (${failure.message})`,
          cause: failure.cause,
        }),
      );
    }),
  );
  return yield* Effect.try({
    try: () => parseDotEnv(contents),
    catch: (cause) => new FunctionsEnvError({ message: dotEnvParseErrorMessage(pathname, cause) }),
  });
});

const dropReservedNames = Effect.fnUntraced(function* (
  env: Readonly<Record<string, string>>,
  warn: boolean,
) {
  const output = yield* Output;
  const kept: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("SUPABASE_")) kept.push([name, value]);
    else if (warn)
      yield* output.raw(`Env name cannot start with SUPABASE_, skipping: ${name}\n`, "stderr");
  }
  return Object.fromEntries(kept);
});

/** A function's own `<functionsDir>/<slug>/.env`, without `SUPABASE_` names. */
export const resolveFunctionEnv = Effect.fn("FunctionsEnv.resolveFunction")(function* (input: {
  readonly functionsDir: string;
  readonly slug: string;
  readonly warn: boolean;
}) {
  const path = yield* Path.Path;
  const env = yield* readFunctionsEnvFile(path.join(input.functionsDir, input.slug, ".env"), true);
  return yield* dropReservedNames(env, input.warn);
});

/** The explicit env file, else `functionsDir/.env`, over the secrets, without `SUPABASE_` names. */
export const resolveSharedFunctionsEnv = Effect.fn("FunctionsEnv.resolveShared")(function* (input: {
  readonly secrets: Readonly<Record<string, string>>;
  readonly functionsDir: string;
  /** An absolute path. */
  readonly envFile: Option.Option<string>;
  readonly warn: boolean;
}) {
  const path = yield* Path.Path;
  const parsed = yield* readFunctionsEnvFile(
    Option.getOrElse(input.envFile, () => path.join(input.functionsDir, ".env")),
    Option.isNone(input.envFile),
  );
  return yield* dropReservedNames({ ...input.secrets, ...parsed }, input.warn);
});

/**
 * The Functions runtime env for `start` and `functions serve`: the shared env, and without an
 * explicit env file each listed function's own `.env`, read before the shared env.
 */
export const resolveFunctionsEnv = Effect.fn("FunctionsEnv.resolve")(function* (input: {
  readonly secrets: Readonly<Record<string, string>>;
  readonly functionsDir: string;
  /** An absolute path. */
  readonly envFile: Option.Option<string>;
  readonly functionSlugs: ReadonlyArray<string>;
  readonly warn: boolean;
}) {
  const functions: Record<string, Record<string, string>> = {};
  for (const slug of Option.isNone(input.envFile) ? input.functionSlugs : []) {
    const env = yield* resolveFunctionEnv({
      functionsDir: input.functionsDir,
      slug,
      warn: input.warn,
    });
    if (Object.keys(env).length > 0) functions[slug] = env;
  }
  const shared = yield* resolveSharedFunctionsEnv(input);
  return { shared, functions };
});
