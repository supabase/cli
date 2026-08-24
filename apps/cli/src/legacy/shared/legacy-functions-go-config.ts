import { Cause, Crypto, Effect } from "effect";
import type { FunctionsGoConfigCompat } from "../../shared/functions/functions-config.ts";
import { LegacyViperEnv } from "../../shared/legacy/legacy-viper-env.ts";
import { legacyLoadLocalProjectContext } from "./legacy-local-project-context.ts";
import { legacyResolveLocalConfigValues } from "./legacy-local-config-values.ts";

function toError(cause: unknown): Cause.UnknownError {
  return new Cause.UnknownError(cause, cause instanceof Error ? cause.message : String(cause));
}

/**
 * Go-parity config resolution for the native `functions` Docker paths
 * (`deploy`/`download`/`serve`), injected into `functions-config.ts`'s
 * `loadFunctionsProjectConfig` so `shared/functions/` never imports
 * `legacy/`-specific validation directly (same isolation rationale as
 * `styleEmphasis`/`styleAqua`).
 *
 * Delegates entirely to the SAME two functions `start`/`stop`/`status`
 * already share — `legacyLoadLocalProjectContext` (dotenv + config load) and
 * `legacyResolveLocalConfigValues` (`Config.Validate`, one home per
 * `apps/cli/CLAUDE.md`) — rather than re-implementing either. Their
 * derived local-dev values (JWTs, URLs) are discarded here; only
 * `projectId`/`edgeRuntimeDenoVersion` and the validation side effect
 * (throws on the first Go-parity failure) matter to these three commands.
 */
export const legacyFunctionsGoConfigCompat = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const viperEnv = yield* LegacyViperEnv;
  const compat: FunctionsGoConfigCompat = {
    load: ({ projectRoot, projectRef }) =>
      Effect.gen(function* () {
        const context = yield* legacyLoadLocalProjectContext(projectRoot, toError, projectRef);
        const validated = yield* legacyResolveLocalConfigValues(
          context.config,
          context.hostname,
          projectRoot,
          context.projectEnvValues,
          context.loaded?.document,
          // No `[remotes.<ref>]` override-tier gating (empty set, the
          // parameter default): the remote block itself already merged over
          // the base config at file level via `legacyLoadLocalProjectContext`'s
          // `projectRef` threading above. Known narrow divergence: without
          // the key set, an ambient `SUPABASE_EDGE_RUNTIME_DENO_VERSION`
          // still beats a matched remote block's own `deno_version`, where
          // Go's OVERRIDE-tier `v.Set` would win — computing the keys here
          // needs `legacy-db-config.toml-read.ts`'s remote-resolution
          // pipeline, which this `loadProjectConfig`-based path doesn't run
          // (review round on CLI-1963).
          undefined,
          projectRef,
        ).pipe(Effect.mapError(toError));
        return {
          loaded: context.loaded,
          projectEnvValues: context.projectEnvValues,
          // `context.projectId`, NOT `validated.projectId`: the context's id is
          // the one built for Docker naming/labels — sanitized, `--project-ref`
          // defaulted, and `SUPABASE_PROJECT_ID`-gated when a `[remotes.<ref>]`
          // block matched (Go installs the remote's own `project_id` at viper's
          // OVERRIDE tier, above `AutomaticEnv` — `pkg/config/config.go:718-724`;
          // see `legacy-local-project-context.ts`'s gate, review
          // PRRT_kwDOErm0O86XHGDL). `validated.projectId` exists only to feed
          // `legacyValidateResolvedConfig`'s emptiness check and deliberately
          // skips that gate — see its own doc comment.
          projectId: context.projectId,
          denoVersion: validated.edgeRuntimeDenoVersion,
        };
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(LegacyViperEnv, viperEnv),
      ),
  };
  return compat;
});
