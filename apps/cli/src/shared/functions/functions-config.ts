import { Crypto, Effect, type FileSystem, Option, type Path } from "effect";
import type { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import type { LoadedCliConfig } from "@supabase/config/effect";
import { loadCliConfig } from "@supabase/config/effect";
import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { CliConfigValues } from "../../config/cli-config-values.service.ts";

type FunctionsLoadedConfig = Pick<LoadedCliConfig, "config" | "document">;

/**
 * Config resolution context shared by the `functions` Docker paths
 * (`deploy`, `download`, `serve`). Callers that inject
 * {@link FunctionsGoConfigCompat} additionally run the config/dotenv
 * validation pipeline `start`/`stop`/`status` already share; callers that
 * omit it keep the plain `loadCliConfig` behavior.
 */
interface FunctionsCliConfigContext {
  readonly loaded: FunctionsLoadedConfig | null;
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
      readonly loaded: FunctionsLoadedConfig | null;
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
 * Docker/API work; callers that don't fall back to `loadCliConfig`.
 */
export const loadFunctionsCliConfig = Effect.fn("FunctionsConfig.load")(function* (input: {
  readonly projectRoot: string;
  readonly projectRef: string | undefined;
  readonly goConfigCompat: FunctionsGoConfigCompat | undefined;
}) {
  yield* Effect.annotateCurrentSpan({
    "config.go_compat": input.goConfigCompat !== undefined,
  });
  if (input.goConfigCompat === undefined) {
    const loaded = yield* loadCliConfig(
      input.projectRoot,
      input.projectRef === undefined ? {} : { projectRef: input.projectRef },
    );
    const values = yield* CliConfigValues;
    const snapshot = yield* values.load({
      workdir: input.projectRoot,
      projectRef: Option.fromNullishOr(input.projectRef),
    });
    return {
      loaded,
      projectEnvValues: undefined,
      projectId: (yield* snapshot.get(CliConfigKeys.projectId)).value,
      denoVersion: loaded?.config.edge_runtime.deno_version,
    } satisfies FunctionsCliConfigContext;
  }

  const context = yield* input.goConfigCompat.load({
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
