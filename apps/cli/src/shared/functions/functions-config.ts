import { Crypto, Effect, type FileSystem, Option, type Path } from "effect";
import type { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import type { LoadedCliConfig } from "@supabase/config/effect";
import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { CliConfigValues, type CliConfigSnapshot } from "../../config/cli-config-values.service.ts";

type FunctionsLoadedConfig = Pick<LoadedCliConfig, "config" | "document">;

/**
 * Config resolution context shared by the `functions` Docker paths
 * (`deploy`, `download`, `serve`). Callers that inject
 * {@link FunctionsGoConfigCompat} additionally run the config/dotenv
 * validation pipeline `start`/`stop`/`status` already share; callers that
 * omit it read the config snapshot alone.
 */
interface FunctionsCliConfigContext {
  readonly loaded: FunctionsLoadedConfig;
  readonly snapshot: CliConfigSnapshot;
  /** The config file's path; `undefined` when the project has none. */
  readonly configPath: string | undefined;
  /** Merged env with ambient values winning; `undefined` when the hook is not injected. */
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
  /** Sanitized project id, resolved after config validation. */
  readonly projectId: string;
  readonly denoVersion: number | undefined;
}

/**
 * Hook that lets a caller run its own config/dotenv validation pipeline
 * without this shared module importing the command tree's validation
 * machinery directly. `undefined` disables the hook.
 */
export interface FunctionsGoConfigCompat {
  readonly load: (input: {
    readonly projectRoot: string;
    readonly projectRef: string | undefined;
  }) => Effect.Effect<
    {
      readonly loaded: FunctionsLoadedConfig;
      readonly snapshot: CliConfigSnapshot;
      readonly configPath: string | undefined;
      readonly projectEnvValues: Readonly<Record<string, string>>;
      readonly projectId: string;
      readonly denoVersion: number;
    },
    Error,
    FileSystem.FileSystem | Path.Path | RuntimeInfo | Crypto.Crypto | CliConfigValues
  >;
}

/**
 * Loads project config for a `functions` command. Callers that provide
 * `goConfigCompat` run its dotenv/config-validate pipeline before any
 * Docker/API work; the others read the config snapshot alone.
 */
export const loadFunctionsCliConfig = Effect.fn("FunctionsConfig.load")(function* (input: {
  readonly projectRoot: string;
  readonly projectRef: string | undefined;
  readonly goConfigCompat: FunctionsGoConfigCompat | undefined;
}) {
  yield* Effect.annotateCurrentSpan({
    "config.go_compat": input.goConfigCompat !== undefined,
  });
  const values = yield* CliConfigValues;
  // Loaded first so a config failure reaches the caller as its own typed error, not as the
  // validation hook's message-only wrapper; the hook's own load reuses this memoised snapshot.
  const snapshot = yield* values.load({
    workdir: input.projectRoot,
    projectRef: Option.fromNullishOr(input.projectRef),
  });
  if (input.goConfigCompat === undefined) {
    return {
      loaded: { config: snapshot.materialized.config, document: snapshot.loaded.document },
      snapshot,
      configPath: snapshot.hasConfigFile ? snapshot.loaded.path : undefined,
      projectEnvValues: undefined,
      projectId: (yield* snapshot.get(CliConfigKeys.projectId)).value,
      denoVersion: snapshot.materialized.config.edge_runtime.deno_version,
    } satisfies FunctionsCliConfigContext;
  }

  const context = yield* input.goConfigCompat.load({
    projectRoot: input.projectRoot,
    projectRef: input.projectRef,
  });
  return {
    loaded: context.loaded,
    snapshot: context.snapshot,
    configPath: context.configPath,
    projectEnvValues: context.projectEnvValues,
    projectId: context.projectId,
    denoVersion: context.denoVersion,
  } satisfies FunctionsCliConfigContext;
});
