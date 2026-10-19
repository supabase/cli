import type { V1ListAllSecretsOutput } from "@supabase/api/effect";
import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { resolveProjectTarget } from "../../../command-internal/target/resolve-project-target.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { mapHttpError, sanitizeInlineName } from "../../../command-internal/http-errors.ts";
import {
  SecretsListNetworkError,
  SecretsListUnexpectedStatusError,
  SecretsNoArgumentsError,
  SecretsUnsetInputError,
  SecretsUnsetNetworkError,
  SecretsUnsetUnexpectedStatusError,
} from "../secrets.errors.ts";
import type { SecretsUnsetFlags } from "./unset.command.ts";

type Secrets = typeof V1ListAllSecretsOutput.Type;

// The `--all` path lists secrets first, so it shares the LIST error pair
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
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  if (flags.all && flags.names.length > 0) {
    return yield* new SecretsUnsetInputError({
      message: "Pass secret names or --all, not both. Nothing was unset.",
    });
  }
  if (!flags.all && flags.names.length === 0) {
    return yield* new SecretsNoArgumentsError({
      message: "No secret names given. Nothing was unset.",
      suggestion:
        "Pass the names to unset, or --all to unset every secret (add --dry-run to preview).",
    });
  }

  const ref = yield* resolveProjectTarget({ remote: flags.remote, projectRef: flags.projectRef });

  yield* Effect.gen(function* () {
    let names: ReadonlyArray<string> = flags.names;

    if (flags.all) {
      const all: Secrets = yield* api.v1
        .listAllSecrets({ ref })
        .pipe(Effect.catch(mapListErrorForUnset));
      names = all.filter((s) => !s.name.startsWith("SUPABASE_")).map((s) => s.name);
    }

    if (names.length === 0) {
      const message = "You have not set any function secrets, nothing to do.";
      if (output.format === "text") {
        yield* output.raw(`${message}\n`, "stderr");
        return;
      }
      yield* output.success(message, {
        project_ref: ref,
        count: 0,
        names,
        dry_run: flags.dryRun,
      });
      return;
    }

    yield* Effect.annotateCurrentSpan({
      "secret.count": names.length,
      "secret.dry_run": flags.dryRun,
    });

    if (flags.dryRun) {
      if (output.format === "text") {
        yield* output.raw(
          `Would unset these function secrets from project ${ref}:\n • ${names.join("\n • ")}\n`,
        );
        return;
      }
      yield* output.success("Dry run: no secrets were unset.", {
        project_ref: ref,
        count: names.length,
        names,
        dry_run: true,
      });
      return;
    }

    yield* requireHostedMutationConsent({
      action: `Unset ${names.length} ${names.length === 1 ? "secret" : "secrets"}`,
      details: ["Secrets to unset:", ...names.map((name) => ` • ${sanitizeInlineName(name)}`)],
    });

    const unsetting =
      output.format === "text" ? yield* output.task("Unsetting secrets...") : undefined;
    yield* api.v1.bulkDeleteSecrets({ ref, body: names }).pipe(
      Effect.tapError(() => unsetting?.fail() ?? Effect.void),
      Effect.catch(mapUnsetError),
    );
    yield* unsetting?.clear ?? Effect.void;

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Finished supabase secrets unset.", {
        project_ref: ref,
        count: names.length,
        names,
        dry_run: false,
      });
      return;
    }

    yield* output.raw("Finished supabase secrets unset.\n");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
