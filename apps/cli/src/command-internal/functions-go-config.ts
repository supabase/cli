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
            context.snapshot.loaded.document,
          ),
        catch: toError,
      });
      return {
        loaded: { config: context.config, document: context.snapshot.loaded.document },
        projectEnvValues: context.projectEnvValues,
        // `context.projectId` is the id built for Docker naming/labels; `validated.projectId`
        // exists only to feed `validateResolvedConfig`'s emptiness check.
        projectId: context.projectId,
        denoVersion: validated.edgeRuntimeDenoVersion,
      };
    }),
};
