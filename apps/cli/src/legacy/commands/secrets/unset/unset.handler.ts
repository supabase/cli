import type { V1ListAllSecretsOutput } from "@supabase/api/effect";
import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
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
// with the `list` handler. Templates match Go's `list.go:46-50` phrasing.
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
  const yes = yield* LegacyYesFlag;
  const tty = yield* Tty;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    let names: ReadonlyArray<string> = flags.names;

    if (names.length === 0) {
      // Go fetches the full list and filters out SUPABASE_-prefixed entries
      // (`unset.go:21-26`). Reuse the LIST error pair here.
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

    let confirmed: boolean;
    if (yes) {
      // Match Go's confirm-by-flag UX: echo the prompt label + `[Y/n] y` to stderr.
      yield* output.raw(`${label}[Y/n] y\n`, "stderr");
      confirmed = true;
    } else if (!tty.stdinIsTty) {
      // Go's `PromptYesNo` defaults to true after a 100ms non-TTY read timeout
      // (no stderr echo). Mirror that.
      confirmed = true;
    } else {
      confirmed = yield* output.promptConfirm(label).pipe(Effect.orElseSucceed(() => false));
    }

    if (!confirmed) {
      return yield* Effect.fail(
        new LegacySecretsUnsetCancelledError({ message: "context canceled" }),
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
