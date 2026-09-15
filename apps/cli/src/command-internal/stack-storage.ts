/**
 * Resolves Storage REST credentials from a managed stack. The endpoint is the stack's `api`
 * gateway URL; Storage is lazy-activated by the gateway itself on the first request
 * (`packages/stack/src/gateway/HttpGateway.ts`), so this module never polls for readiness and
 * never falls back to the legacy Kong-derived endpoint.
 */

import { Data, Effect, Option, Redacted } from "effect";
import type { EffectStack } from "@supabase/stack/effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { StackApi } from "./stack-api.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { stackOpenProjectBy } from "./stack-local-database.ts";
import { StorageGatewayStatusError } from "./storage-gateway.errors.ts";
import type { StorageCredentials } from "./storage-credentials.ts";

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
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.disabled === true ? actionability.invalidConfig : actionability.startStack;
  }
}

/** Storage REST credentials resolved from an already-open stack handle. */
export const stackStorageEndpointFor = (
  stack: EffectStack,
): Effect.Effect<StorageCredentials, StackStorageUnavailableError | StackStorageCapabilityError> =>
  Effect.gen(function* () {
    const status = yield* stack.status.pipe(
      Effect.mapError((cause) => new StackStorageUnavailableError({ message: cause.message })),
    );
    if (status.lifecycle !== "running") {
      return yield* new StackStorageUnavailableError({
        message: `The stack is ${status.lifecycle}, not running.`,
        suggestion: "Run supabase start.",
      });
    }
    const apiEndpoint = status.endpoints.api;
    if (apiEndpoint === undefined) {
      return yield* new StackStorageUnavailableError({
        message: "The stack exposes no API gateway endpoint.",
      });
    }
    const capability = status.capabilities.find((entry) => entry.name === "storage");
    if (capability === undefined) {
      return yield* new StackStorageCapabilityError({
        message: "The stack reports no Storage capability.",
      });
    }
    if (capability.state === "disabled") {
      return yield* new StackStorageCapabilityError({
        message: "Storage is disabled for this stack.",
        suggestion:
          "Start the stack with Storage enabled: remove `-x storage` or set `[storage] enabled = true`.",
        disabled: true,
      });
    }
    if (capability.state === "failed" || capability.state === "stopped") {
      return yield* new StackStorageCapabilityError({
        message: `Storage is ${capability.state} for this stack.${
          capability.error === undefined ? "" : `: ${capability.error}`
        }`,
        suggestion: "Run supabase start.",
      });
    }
    const credentials = yield* stack.credentials.pipe(
      Effect.mapError((cause) => new StackStorageUnavailableError({ message: cause.message })),
    );
    if (credentials.api === undefined) {
      return yield* new StackStorageUnavailableError({
        message: "The stack exposes no API credentials.",
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
  return yield* stackStorageEndpointFor(opened.value);
});

/**
 * Maps a stack-gateway activation failure into `StackStorageCapabilityError` guidance when the
 * stack backend is selected; the legacy backend never raises `StorageGatewayStatusError` this
 * way, so it is passed through unchanged.
 */
export const withStackStorageGuidance = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StackStorageCapabilityError, R> =>
  Effect.gen(function* () {
    const backend = yield* currentStackBackend;
    if (backend.kind !== "stack") return yield* effect;
    return yield* effect.pipe(
      Effect.catch((error): Effect.Effect<never, E | StackStorageCapabilityError> => {
        if (!(error instanceof StorageGatewayStatusError)) return Effect.fail(error);
        if (error.status !== 502 && error.status !== 503) return Effect.fail(error);
        return Effect.fail(
          new StackStorageCapabilityError({
            message: `The stack gateway could not activate Storage (HTTP ${error.status}).`,
            suggestion: "Check `supabase stack logs` / restart the stack.",
          }),
        );
      }),
    );
  });
