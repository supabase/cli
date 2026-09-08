import type { V1ListAllSecretsOutput } from "@supabase/api/effect";
import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveYes } from "../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../shared/output/errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  SecretsListNetworkError,
  SecretsListUnexpectedStatusError,
  SecretsUnsetCancelledError,
  SecretsUnsetNetworkError,
  SecretsUnsetUnexpectedStatusError,
} from "../secrets.errors.ts";
import type { SecretsUnsetFlags } from "./unset.command.ts";

type Secrets = typeof V1ListAllSecretsOutput.Type;

// The empty-args path lists secrets first, so it shares the LIST error pair
// with the `list` handler.
const mapListErrorForUnset = mapHttpError({
  networkError: SecretsListNetworkError,
  statusError: SecretsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list secrets: ${cause}`,
  statusMessage: (status, body) => `unexpected list secrets status ${status}: ${body}`,
});

const mapUnsetError = mapHttpError({
  networkError: SecretsUnsetNetworkError,
  statusError: SecretsUnsetUnexpectedStatusError,
  networkMessage: (cause) => `failed to delete secrets: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error unsetting project secrets: ${body}`,
});

export const secretsUnset = Effect.fn("secrets.unset")(function* (flags: SecretsUnsetFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  // `--yes` OR `SUPABASE_YES` (mirrors viper's AutomaticEnv, root.go:318-320).
  const yes = yield* resolveYes;

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
    const confirmed = yield* promptYesNo(output, yes, label, true);

    if (!confirmed) {
      return yield* Effect.fail(
        new SecretsUnsetCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
      );
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
