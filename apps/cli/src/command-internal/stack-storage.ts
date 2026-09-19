/**
 * Resolves Storage REST credentials from a managed stack. The endpoint is a composition HTTP
 * endpoint; lazy Storage members may be woken by the first gateway request.
 */

import { Data, Effect, Match, Option, Path, Redacted } from "effect";
import type { Observation, ServiceInstance, Stack } from "@supabase/stack/effect";
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
import { generateGoJwt } from "./go-jwt.ts";

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
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.disabled === true ? actionability.invalidConfig : actionability.startStack;
  }
}

const capabilityState = (observation: Observation | undefined) => {
  if (observation === undefined) return undefined;
  if (observation.error !== undefined) return "failed" as const;
  if (observation.health === "unhealthy") return "failed" as const;
  if (observation.lifecycle === "stopped" && observation.wakeEnabled) return "dormant" as const;
  if (observation.lifecycle === "stopping" && observation.wakeEnabled) return "dormant" as const;
  if (observation.lifecycle === "running" && observation.health === "healthy")
    return "ready" as const;
  if (observation.lifecycle === "running") return "starting" as const;
  return observation.lifecycle;
};

/** Resolves bucket-seeding credentials from a configured Storage instance. */
export const stackStorageCredentialsFor = (
  storage: ServiceInstance<"storage">,
  jwtSecret: string,
): Effect.Effect<StorageCredentials, StackStorageUnavailableError | StackStorageCapabilityError> =>
  storage.status.pipe(
    Effect.mapError((cause) => new StackStorageUnavailableError({ message: cause.message })),
    Effect.flatMap(
      (
        observation,
      ): Effect.Effect<
        StorageCredentials,
        StackStorageUnavailableError | StackStorageCapabilityError
      > => {
        if (classifyStorageCapability(observation) !== "proceed")
          return Effect.fail(
            new StackStorageUnavailableError({ message: describeStorageCapability(observation) }),
          );
        return storageCredentialsFrom(observation, jwtSecret);
      },
    ),
  );

/** Classifies the composition Storage observation without starting it. */
export const classifyStorageCapability = (
  observation: Observation | undefined,
): "proceed" | "disabled" | "unusable" => {
  const state = capabilityState(observation);
  if (state === undefined) return "disabled";
  return Match.value(state).pipe(
    Match.when("dormant", () => "proceed" as const),
    Match.when("starting", () => "proceed" as const),
    Match.when("ready", () => "proceed" as const),
    Match.whenOr("stopped", "stopping", "failed", () => "unusable" as const),
    Match.exhaustive,
  );
};

const withTerminalPunctuation = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Renders the current Storage observation for command diagnostics. */
export const describeStorageCapability = (observation: Observation | undefined): string => {
  const state = capabilityState(observation);
  if (state === undefined) return "Storage is disabled for this stack.";
  if (state === "failed") {
    const detail = observation?.error?.message;
    return `Storage failed to start for this stack${
      detail === undefined ? "." : `: ${withTerminalPunctuation(sanitizeInlineName(detail))}`
    }`;
  }
  if (state === "stopped" || state === "stopping") return "Storage is stopped for this stack.";
  return "Storage is available for this stack.";
};

const notRunningSuggestion = (lifecycle: "starting" | "stopping" | "stopped"): string =>
  Match.value(lifecycle).pipe(
    Match.when("starting", () => "The stack is still starting; retry shortly."),
    Match.when(
      "stopping",
      () => "The stack is shutting down; run supabase start once it has stopped.",
    ),
    Match.when("stopped", () => "Run supabase start."),
    Match.exhaustive,
  );

const storageCredentialsFrom = (
  observation: Observation,
  jwtSecret: string,
): Effect.Effect<StorageCredentials, StackStorageCapabilityError> => {
  const endpoint = observation.endpoints.find(({ name }) => name === "http");
  return endpoint === undefined
    ? Effect.fail(
        new StackStorageCapabilityError({ message: "The stack exposes no Storage endpoint." }),
      )
    : Effect.succeed({
        baseUrl: `http://${endpoint.host}:${endpoint.port}`,
        apiKey: generateGoJwt(jwtSecret, "service_role"),
        localKongCa: undefined,
      });
};

/** Resolves the composition Storage endpoint without launching the owner or any member. */
export const stackStorageEndpointFor = (
  stack: Stack,
): Effect.Effect<StorageCredentials, StackStorageUnavailableError | StackStorageCapabilityError> =>
  Effect.gen(function* () {
    const composition = yield* stack.composition.describe.pipe(
      Effect.mapError((cause) => new StackStorageUnavailableError({ message: cause.message })),
    );
    const members = yield* Effect.forEach(composition.members, ({ id }) =>
      stack.services
        .get(id)
        .pipe(
          Effect.mapError((cause) => new StackStorageUnavailableError({ message: cause.message })),
        ),
    );
    const storage = members.find((instance) => instance.service === "storage");
    if (storage === undefined)
      return yield* new StackStorageCapabilityError({
        message: "Storage is disabled for this stack.",
        suggestion:
          "Set [storage] enabled = true in supabase/config.toml, then run supabase start without --exclude storage.",
        disabled: true,
      });
    const database = members.find((instance) => instance.service === "database");
    if (database === undefined)
      return yield* new StackStorageUnavailableError({
        message: "The stack has no primary database composition member.",
        suggestion: INSPECT_OR_RESTART_SUGGESTION,
      });
    const databaseObservation = yield* database.status.pipe(
      Effect.mapError((cause) => new StackStorageUnavailableError({ message: cause.message })),
    );
    if (databaseObservation.lifecycle !== "running" || databaseObservation.health !== "healthy")
      return yield* new StackStorageUnavailableError({
        message: "The primary database is not ready for Storage requests.",
        suggestion:
          databaseObservation.health === "starting"
            ? notRunningSuggestion("starting")
            : databaseObservation.lifecycle === "starting" ||
                databaseObservation.lifecycle === "stopping" ||
                databaseObservation.lifecycle === "stopped"
              ? notRunningSuggestion(databaseObservation.lifecycle)
              : INSPECT_OR_RESTART_SUGGESTION,
      });
    const storageObservation = yield* storage.status.pipe(
      Effect.mapError((cause) => new StackStorageCapabilityError({ message: cause.message })),
    );
    if (classifyStorageCapability(storageObservation) !== "proceed")
      return yield* new StackStorageCapabilityError({
        message: describeStorageCapability(storageObservation),
        suggestion: "Run supabase stack restart, then retry.",
      });
    if (databaseObservation.config.service !== "database")
      return yield* new StackStorageUnavailableError({
        message: "The primary database configuration is unavailable.",
        suggestion: INSPECT_OR_RESTART_SUGGESTION,
      });
    return yield* storageCredentialsFrom(
      storageObservation,
      Redacted.value(databaseObservation.config.config.jwtSecret),
    );
  });

/** Storage credentials for the project stack, opening it without launching the owner. */
export const stackStorageEndpoint: Effect.Effect<
  StorageCredentials,
  StackStorageUnavailableError | StackStorageCapabilityError,
  CommandSettings | StackApi | Path.Path
> = Effect.gen(function* () {
  const opened = yield* stackOpenProjectBy(
    (cause) => new StackStorageUnavailableError({ message: cause.message }),
  );
  if (Option.isNone(opened))
    return yield* new StackStorageUnavailableError({
      message: "No stack is registered for this project.",
      suggestion: "Run supabase start to create it.",
    });
  return yield* stackStorageEndpointFor(opened.value);
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
        const body = sanitizeInlineName(error.body);
        return Effect.fail(
          new StackStorageCapabilityError({
            message: `The stack gateway returned HTTP ${error.status} for Storage${
              body.length === 0 ? "." : `: ${body}`
            }`,
            suggestion: "Run supabase stack logs to inspect Storage, then supabase stack restart.",
            cause: error,
          }),
        );
      }),
    );
  });
