import type { V1ListAllSecretsOutput } from "@supabase/api/effect";
import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacySecretsListNetworkError,
  LegacySecretsListUnexpectedStatusError,
  LegacySecretsUnsetCancelledError,
  LegacySecretsUnsetNetworkError,
  LegacySecretsUnsetUnexpectedStatusError,
} from "../secrets.errors.ts";
import type { LegacySecretsUnsetFlags } from "./unset.command.ts";

type Secrets = typeof V1ListAllSecretsOutput.Type;

// The empty-args path lists secrets first, so it shares the LIST error pair
// with the `list` handler.
const mapListErrorForUnset = mapLegacyHttpError({
  networkError: LegacySecretsListNetworkError,
  statusError: LegacySecretsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list secrets: ${cause}`,
  statusMessage: (status, body) => `unexpected list secrets status ${status}: ${body}`,
});

const mapUnsetError = mapLegacyHttpError({
  networkError: LegacySecretsUnsetNetworkError,
  statusError: LegacySecretsUnsetUnexpectedStatusError,
  networkMessage: (cause) => `failed to delete secrets: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error unsetting project secrets: ${body}`,
});

export const legacySecretsUnset = Effect.fn("legacy.secrets.unset")(function* (
  flags: LegacySecretsUnsetFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  // `--yes` OR `SUPABASE_YES` (mirrors viper's AutomaticEnv, root.go:318-320).
  const yes = yield* legacyResolveYes;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    let names: ReadonlyArray<string> = flags.names;

    if (names.length === 0) {
      // Fetches the full list and filters out SUPABASE_-prefixed entries.
      // Reuse the LIST error pair here.
      const all: Secrets = yield* api.v1
        .listAllSecrets({ ref })
        .pipe(Effect.catch(mapListErrorForUnset));
      names = all.filter((s) => !s.name.startsWith("SUPABASE_")).map((s) => s.name);
    }

    if (names.length === 0) {
      yield* output.raw("You have not set any function secrets, nothing to do.\n", "stderr");
      return;
    }

    const label = `Do you want to unset these function secrets?\n • ${names.join("\n • ")}\n\n`;

    // `PromptYesNo(msg, true)` (`console.go:64-82`): `--yes`/`SUPABASE_YES`
    // auto-confirms with the `<label> [Y/n] y` stderr echo; a non-TTY stdin
    // still prints the label and scans one piped line (100ms), so `echo n |
    // supabase secrets unset` declines instead of hardcoding the Yes default
    // (CLI-1974).
    const confirmed = yield* legacyPromptYesNo(output, yes, label, true);

    if (!confirmed) {
      return yield* new LegacySecretsUnsetCancelledError({ message: CONTEXT_CANCELED_MESSAGE });
    }

    const unsetting =
      output.format === "text" ? yield* output.task("Unsetting secrets...") : undefined;
    yield* api.v1.bulkDeleteSecrets({ ref, body: names }).pipe(
      Effect.tapError(() => unsetting?.fail() ?? Effect.void),
      Effect.catch(mapUnsetError),
    );
    yield* unsetting?.clear() ?? Effect.void;

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Finished supabase secrets unset.", {
        project_ref: ref,
        count: names.length,
      });
      return;
    }

    yield* output.raw("Finished supabase secrets unset.\n");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
