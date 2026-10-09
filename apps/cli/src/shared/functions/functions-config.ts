import { Crypto, Effect, type FileSystem, Option, type Path } from "effect";
import type { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import type { LoadedCliConfig } from "@supabase/config/effect";
import { CliConfigValues, type CliConfigSnapshot } from "../../config/cli-config-values.service.ts";

type FunctionsLoadedConfig = Pick<LoadedCliConfig, "config" | "document">;

/**
 * Config resolution context shared by the `functions` Docker paths
 * (`deploy`, `download`, `serve`), produced by the injected
 * {@link FunctionsLocalConfigLoader}.
 */
interface FunctionsCliConfigContext {
  readonly loaded: FunctionsLoadedConfig;
  readonly snapshot: CliConfigSnapshot;
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
  // validation hook's message-only wrapper; the hook's own load reuses this memoised snapshot.
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
    snapshot: context.snapshot,
    configPath: context.configPath,
    projectEnvValues: context.projectEnvValues,
    projectId: context.projectId,
    denoVersion: context.denoVersion,
  } satisfies FunctionsCliConfigContext;
});
