import { Effect } from "effect";
import type { FunctionsGoConfigCompat } from "../shared/functions/functions-config.ts";
import { loadLocalProjectContext } from "./local-project-context.ts";
import { resolveLocalConfigValues } from "./local-config-values.ts";

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Config resolution for the native `functions` Docker paths (`deploy`/`download`/`serve`),
 * injected into `functions-config.ts`'s `loadFunctionsCliConfig` so `shared/functions/` never
 * imports the command tree's validation directly.
 *
 * Delegates to the same `loadLocalProjectContext`/`resolveLocalConfigValues` pair
 * `start`/`stop`/`status` already use, rather than re-implementing either. Their derived
 * local-dev values (JWTs, URLs) are discarded here; only `projectId`/`edgeRuntimeDenoVersion` and
 * the validation side effect (throws on the first failure) matter to these three commands.
 */
export const functionsGoConfigCompat: FunctionsGoConfigCompat = {
  load: ({ projectRoot, projectRef }) =>
    Effect.gen(function* () {
      const context = yield* loadLocalProjectContext(projectRoot, toError, projectRef);
      const validated = yield* Effect.try({
        try: () =>
          resolveLocalConfigValues(
            context.config,
            context.hostname,
            projectRoot,
            context.projectEnvValues,
            context.loaded?.document,
            // No `[remotes.<ref>]` override-tier gating (empty set, the default): the remote
            // block already merged over the base config at file level via
            // `loadLocalProjectContext`'s `projectRef` threading above. Known narrow divergence:
            // an ambient `SUPABASE_EDGE_RUNTIME_DENO_VERSION` still beats a matched remote
            // block's own `deno_version` here, since computing the override keys needs
            // `db-config.toml-read.ts`'s remote-resolution pipeline, which this path doesn't run.
            undefined,
            projectRef,
          ),
        catch: toError,
      });
      return {
        loaded: context.loaded,
        projectEnvValues: context.projectEnvValues,
        // `context.projectId`, not `validated.projectId`: the context's id is the one built for
        // Docker naming/labels — sanitized, `--project-ref` defaulted, and
        // `SUPABASE_PROJECT_ID`-gated when a `[remotes.<ref>]` block matched (see
        // `local-project-context.ts`'s gate). `validated.projectId` exists only to feed
        // `validateResolvedConfig`'s emptiness check and skips that gate — see its own doc
        // comment.
        projectId: context.projectId,
        denoVersion: validated.edgeRuntimeDenoVersion,
      };
    }),
};
