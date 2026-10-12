import { Effect, type Crypto, type FileSystem, type Path } from "effect";
import type { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import type { LoadedCliConfig } from "@supabase/config/effect";

/**
 * Config resolution context shared by the `functions` Docker paths
 * (`deploy`, `download`, `serve`), produced by the injected
 * {@link FunctionsLocalConfigLoader}.
 */
interface FunctionsCliConfigContext {
  readonly loaded: LoadedCliConfig | null;
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
      readonly loaded: LoadedCliConfig | null;
      readonly projectEnvValues: Readonly<Record<string, string>>;
      readonly projectId: string;
      readonly denoVersion: number;
    },
    Error,
    FileSystem.FileSystem | Path.Path | RuntimeInfo | Crypto.Crypto
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
  const context = yield* input.localConfigLoader.load({
    projectRoot: input.projectRoot,
    projectRef: input.projectRef,
  });
  return {
    loaded: context.loaded,
    projectEnvValues: context.projectEnvValues,
    projectId: context.projectId,
    denoVersion: context.denoVersion,
  } satisfies FunctionsCliConfigContext;
});
