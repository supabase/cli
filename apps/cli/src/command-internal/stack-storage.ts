/**
 * Resolves Storage REST credentials from a managed stack. The endpoint is the stack's `api`
 * gateway URL; Storage is lazy-activated by the gateway itself on the first request
 * (`packages/stack/src/gateway/HttpGateway.ts`), so this module never polls for readiness and
 * never falls back to the legacy Kong-derived endpoint.
 */

import { Data, Effect, Match, Option, Redacted } from "effect";
import type { CapabilityStatus, EffectStack, StackStatus } from "@supabase/stack/effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { StackApi } from "./stack-api.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { stackOpenProjectBy } from "./stack-local-database.ts";
import { sanitizeInlineName } from "./http-errors.ts";
import { StorageGatewayStatusError } from "./storage-gateway.errors.ts";
import type { StorageCredentials } from "./storage-credentials.ts";

const INSPECT_OR_RESTART_SUGGESTION =
  "Run supabase stack status to inspect the stack, or supabase stack restart.";

/** The stack cannot currently be reached to serve Storage requests. */
export class StackStorageUnavailableError extends Data.TaggedError("StackStorageUnavailableError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** The stack is reachable, but its Storage capability cannot currently serve requests. */
export class StackStorageCapabilityError extends Data.TaggedError("StackStorageCapabilityError")<{
  readonly message: string;
  readonly suggestion?: string;
  readonly disabled?: boolean;
  /** The original error, preserved for `--debug` (e.g. a `StorageGatewayStatusError`). */
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.disabled === true ? actionability.invalidConfig : actionability.startStack;
  }
}

/**
 * Classifies a stack's Storage capability for reporting purposes: `"proceed"` when the gateway
 * can serve requests (including lazy activation states), `"disabled"` when Storage was excluded
 * from the stack, and `"unusable"` when it stopped, failed, or is absent entirely.
 */
export const classifyStorageCapability = (
  capability: CapabilityStatus | undefined,
): "proceed" | "disabled" | "unusable" => {
  if (capability === undefined) return "unusable";
  return Match.value(capability.state).pipe(
    Match.when("disabled", () => "disabled" as const),
    Match.whenOr("dormant", "starting", "ready", () => "proceed" as const),
    Match.whenOr("stopped", "failed", () => "unusable" as const),
    Match.exhaustive,
  );
};

const notRunningSuggestion = (lifecycle: Exclude<StackStatus["lifecycle"], "running">): string =>
  Match.value(lifecycle).pipe(
    Match.when("starting", () => "The stack is still starting; retry shortly."),
    Match.when("stopping", () => "The stack is shutting down; retry once it has stopped."),
    Match.when(
      "destroying",
      () => "The stack is being destroyed; run supabase start to create a new one.",
    ),
    Match.whenOr("stopped", "unconfigured", () => "Run supabase start."),
    Match.exhaustive,
  );

/** Storage REST credentials resolved from an already-open stack handle and its current status. */
export const stackStorageEndpointFor = (
  stack: EffectStack,
  status: StackStatus,
): Effect.Effect<StorageCredentials, StackStorageUnavailableError | StackStorageCapabilityError> =>
  Effect.gen(function* () {
    if (status.lifecycle !== "running") {
      return yield* new StackStorageUnavailableError({
        message:
          status.lifecycle === "unconfigured"
            ? "The stack has not been started yet."
            : `The stack is ${status.lifecycle}, not running.`,
        suggestion: notRunningSuggestion(status.lifecycle),
      });
    }
    const apiEndpoint = status.endpoints.api;
    if (apiEndpoint === undefined) {
      return yield* new StackStorageUnavailableError({
        message: "The stack exposes no API gateway endpoint.",
        suggestion: INSPECT_OR_RESTART_SUGGESTION,
      });
    }
    const capability = status.capabilities.find((entry) => entry.name === "storage");
    const classification = classifyStorageCapability(capability);
    if (classification === "disabled") {
      return yield* new StackStorageCapabilityError({
        message: "Storage is disabled for this stack.",
        suggestion:
          "Set [storage] enabled = true in supabase/config.toml, or start without -x storage, then run supabase stack restart.",
        disabled: true,
      });
    }
    if (classification === "unusable") {
      if (capability === undefined) {
        return yield* new StackStorageCapabilityError({
          message: "The stack reports no Storage capability.",
          suggestion: INSPECT_OR_RESTART_SUGGESTION,
        });
      }
      return yield* new StackStorageCapabilityError({
        message:
          capability.state === "failed"
            ? `Storage failed to start for this stack${
                capability.error === undefined ? "." : `: ${sanitizeInlineName(capability.error)}`
              }`
            : "Storage is stopped for this stack.",
        suggestion: "Run supabase stack restart, then retry.",
      });
    }
    const credentials = yield* stack.credentials.pipe(
      Effect.mapError((cause) => new StackStorageUnavailableError({ message: cause.message })),
    );
    if (credentials.api === undefined) {
      return yield* new StackStorageUnavailableError({
        message: "The stack exposes no API credentials.",
        suggestion: INSPECT_OR_RESTART_SUGGESTION,
      });
    }
    return {
      baseUrl: apiEndpoint.url,
      apiKey: Redacted.value(credentials.api.serviceRoleJwt),
      localKongCa: undefined,
    } satisfies StorageCredentials;
  });

/** Storage REST credentials for the project stack, opening it from the command's workdir. */
export const stackStorageEndpoint: Effect.Effect<
  StorageCredentials,
  StackStorageUnavailableError | StackStorageCapabilityError,
  CommandSettings
> = Effect.gen(function* () {
  const api = yield* Effect.serviceOption(StackApi);
  if (Option.isNone(api)) {
    return yield* new StackStorageUnavailableError({
      message: "The stack API is unavailable for this command.",
      suggestion: "Re-run with --debug and report this at https://github.com/supabase/cli/issues.",
    });
  }
  const opened = yield* stackOpenProjectBy(
    (cause) =>
      new StackStorageUnavailableError({
        message: cause.message,
      }),
  );
  if (Option.isNone(opened)) {
    return yield* new StackStorageUnavailableError({
      message: "No stack is registered for this project.",
      suggestion: "Run supabase start to create it.",
    });
  }
  const status = yield* opened.value.status.pipe(
    Effect.mapError((cause) => new StackStorageUnavailableError({ message: cause.message })),
  );
  return yield* stackStorageEndpointFor(opened.value, status);
});

/**
 * Maps a stack-gateway activation failure into `StackStorageCapabilityError` guidance, only for
 * a local target on the stack backend; a `--linked` (hosted) failure is passed through unchanged
 * even when the stack backend is selected.
 */
export const withStackStorageGuidance = <A, E, R>(
  target: { readonly local: boolean },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StackStorageCapabilityError, R> =>
  Effect.gen(function* () {
    if (!target.local) return yield* effect;
    const backend = yield* currentStackBackend;
    if (backend.kind !== "stack") return yield* effect;
    return yield* effect.pipe(
      Effect.catch((error): Effect.Effect<never, E | StackStorageCapabilityError> => {
        if (!(error instanceof StorageGatewayStatusError)) return Effect.fail(error);
        if (error.status !== 502 && error.status !== 503) return Effect.fail(error);
        return Effect.fail(
          new StackStorageCapabilityError({
            message: `The stack gateway could not activate Storage (HTTP ${error.status}).`,
            suggestion:
              "Run supabase stack logs to inspect the failure, then supabase stack restart.",
            cause: error,
          }),
        );
      }),
    );
  });
