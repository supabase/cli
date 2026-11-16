import {
  openApiOperationIdMap,
  operationDefinitions,
  type OpenApiOperationId,
  type OperationInput,
  type OperationId,
} from "@supabase/api/effect";
import { Duration, Effect, Option, Runtime, Schedule, Schema } from "effect";
import { HttpClientResponse } from "effect/http";
import { stringify } from "yaml";
import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { parseDuration } from "../duration.ts";
import { requireExperimental } from "../experimental-gate.ts";
import { OutputFlag } from "../global-flags.ts";
import { requireHostedMutationConsent } from "../hosted-consent/hosted-consent.ts";
import { HostedMutationDeclinedError } from "../hosted-consent/hosted-consent.errors.ts";
import { mapHttpError, sanitizeInlineName } from "../http-errors.ts";
import { resolveProjectTarget } from "../target/resolve-project-target.ts";
import type { projectTargetFlags } from "../target/target-flags.ts";
import type { Command } from "effect/cli";
import { Output } from "../../shared/output/output.service.ts";
import { normalizeCliError } from "../../shared/output/normalize-error.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import {
  ApiCommandInputError,
  ApiCommandNetworkError,
  ApiCommandStatusError,
  ApiCommandWaitError,
} from "./errors.ts";
import type { ApiCommandData } from "./model.ts";

export type ApiCommandFlags = Command.Command.Config.Infer<
  ReturnType<typeof projectTargetFlags>
> & {
  readonly input: Readonly<Record<string, unknown>>;
  readonly wait: boolean;
  readonly timeout: string;
};

const mapError = mapHttpError({
  networkError: ApiCommandNetworkError,
  statusError: ApiCommandStatusError,
  networkMessage: (cause) => `Management API request failed: ${cause}`,
  statusMessage: (status, body) =>
    `Management API request failed (${status}): ${sanitizeInlineName(body)}`,
});

function setPath(
  object: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
): void {
  const [key, ...rest] = path;
  if (key === undefined) return;
  if (rest.length === 0) {
    object[key] = value;
    return;
  }
  const child = object[key];
  const nested =
    typeof child === "object" && child !== null && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child))
      : {};
  setPath(nested, rest, value);
  object[key] = nested;
}

const pointerValue = (value: unknown, pointer: string): unknown => {
  let current = value;
  for (const segment of pointer.slice(1).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key))
      return undefined;
    current = Reflect.get(current, key);
  }
  return current;
};

const validateInput = (id: OpenApiOperationId, input: unknown) => {
  const definition = operationDefinitions[openApiOperationIdMap[id]];
  const schema: Schema.Decoder<OperationInput<OperationId>> = definition.inputSchema;
  return Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () =>
        new ApiCommandInputError({
          message: `Invalid input for ${id}. Check the flags shown by --help.`,
        }),
    ),
  );
};

const execute = Effect.fnUntraced(function* (id: OpenApiOperationId, input: unknown) {
  const api = yield* CommandPlatformApi;
  const validated = yield* validateInput(id, input);
  return yield* api.executeRaw(operationDefinitions[openApiOperationIdMap[id]], validated).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.catch(mapError),
  );
});

export const validateApiCommand = Effect.fnUntraced(function* (
  command: ApiCommandData,
  flags: ApiCommandFlags,
) {
  const output = yield* Output;
  const format = yield* OutputFlag;
  if (
    (Option.isSome(format) && !["json", "yaml"].includes(format.value)) ||
    (Option.isNone(format) && output.format === "stream-json")
  ) {
    return yield* new ApiCommandInputError({
      message:
        "Generated commands support JSON or YAML output. Use -o json, -o yaml, or --output-format json.",
    });
  }
  if (command.experimental) yield* requireExperimental;
  if (flags.wait && !command.wait)
    return yield* new ApiCommandInputError({ message: "This operation does not support --wait." });
  const timeout = yield* Effect.try({
    try: () => parseDuration(flags.timeout) / 1_000_000,
    catch: () =>
      new ApiCommandInputError({
        message: "--timeout must be a positive duration, for example 15m.",
      }),
  });
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    return yield* new ApiCommandInputError({
      message: "--timeout must be positive and no longer than 596h.",
    });
  }
  return timeout;
});

export const executeApiCommand = Effect.fn("ApiCommand.run")(function* (
  command: ApiCommandData,
  flags: ApiCommandFlags,
  timeout: number,
) {
  const output = yield* Output;
  const cache = yield* LinkedProjectCache;
  const telemetry = yield* TelemetryState;
  const run = Effect.gen(function* () {
    const input: Record<string, unknown> = {};
    for (const field of command.fields) {
      const value = flags.input[field.name];
      if (value !== undefined) setPath(input, field.path, value);
    }
    for (const constant of command.constants) setPath(input, constant.path, constant.value);
    const ref = yield* resolveProjectTarget({ remote: flags.remote, projectRef: flags.projectRef });
    input.ref = ref;
    return yield* Effect.gen(function* () {
      yield* validateInput(command.operationId, input);
      yield* requireHostedMutationConsent({ action: command.summary });
      const task = yield* output.task(`${command.summary}...`);
      const accepted = yield* execute(command.operationId, input).pipe(
        Effect.tapError(() => task.fail()),
      );
      yield* task.clear;
      let result = accepted;
      if (flags.wait && command.wait) {
        const wait = command.wait;
        const parameters: Record<string, unknown> = { ref };
        for (const [name, pointer] of Object.entries(wait.params)) {
          const value = pointerValue(accepted, pointer);
          if (value === undefined || value === null)
            return yield* new ApiCommandWaitError({
              reason: "invalid_response",
              message: "The API accepted the request but omitted a required polling parameter.",
              suggestion: "Inspect the resource in the dashboard before retrying.",
            });
          parameters[name] = value;
        }
        let attempts = 0;
        const poll = Effect.gen(function* () {
          attempts += 1;
          const response = yield* execute(wait.read, parameters);
          const status = pointerValue(response, wait.status);
          if (typeof status !== "string")
            return yield* new ApiCommandWaitError({
              reason: "invalid_response",
              message: "The status response did not contain a valid status.",
              suggestion: "Inspect the resource in the dashboard before retrying.",
            });
          if (wait.failed.includes(status)) {
            const error = wait.error ? pointerValue(response, wait.error) : undefined;
            return yield* new ApiCommandWaitError({
              reason: "failed",
              message:
                typeof error === "string"
                  ? sanitizeInlineName(error)
                  : `Operation ended with status ${sanitizeInlineName(status)}.`,
              suggestion: "Inspect the resource in the dashboard before retrying.",
            });
          }
          return { response, complete: wait.succeeded.includes(status) };
        }).pipe(Effect.withTracerEnabled(false));
        const waiting = yield* output.task("Waiting for completion...");
        const completed = yield* poll.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (value) => value.complete,
          }),
          Effect.timeoutOrElse({
            duration: Duration.millis(timeout),
            orElse: () =>
              Effect.fail(
                new ApiCommandWaitError({
                  reason: "timeout",
                  message:
                    "Timed out waiting for completion. The accepted operation may still be running.",
                  suggestion:
                    "Inspect the resource in the dashboard. Stopping the wait does not cancel server work.",
                }),
              ),
          }),
          Effect.ensuring(
            Effect.suspend(() => Effect.annotateCurrentSpan("poll.attempts", attempts)),
          ),
          Effect.tapError(() => waiting.fail()),
          Effect.withSpan("ApiCommand.wait"),
        );
        yield* waiting.clear;
        result = completed.response;
      }
      const format = yield* OutputFlag;
      const tty = yield* Tty;
      const yaml = Option.isSome(format)
        ? format.value === "yaml"
        : output.format === "text" && tty.stdoutIsTty;
      yield* output.raw(
        yaml
          ? stringify(result)
          : `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(result)}\n`,
      );
    }).pipe(Effect.ensuring(cache.cache(ref)));
  });
  return yield* run.pipe(Effect.ensuring(telemetry.flush));
});

const apiErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({ code: Schema.String, message: Schema.String }),
    }),
  ),
);

export const withApiCommandErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const output = yield* Output;
        const process = yield* ProcessControl;
        const normalized = normalizeCliError(error);
        const apiError = Schema.is(ApiCommandStatusError)(error)
          ? apiErrorBody(error.body)
          : Option.none();
        const usage =
          Schema.is(ApiCommandInputError)(error) ||
          normalized.code === "ExperimentalRequiredError" ||
          normalized.code === "HostedMutationConsentRequiredError";
        const status = Schema.is(ApiCommandStatusError)(error) ? error.status : null;
        const statusCodes: Readonly<Record<number, string>> = {
          400: "invalid_input",
          401: "unauthenticated",
          403: "forbidden",
          404: "not_found",
          409: "conflict",
          422: "invalid_input",
          429: "rate_limited",
        };
        const code = usage
          ? "usage_error"
          : Schema.is(ApiCommandWaitError)(error)
            ? error.reason === "timeout"
              ? "wait_timeout"
              : error.reason === "failed"
                ? "operation_failed"
                : "api_error"
            : Schema.is(ApiCommandNetworkError)(error)
              ? error.decode
                ? "api_error"
                : "network_error"
              : status !== null
                ? (statusCodes[status] ?? "api_error")
                : normalized.code === "AccessTokenRequiredError"
                  ? "unauthenticated"
                  : "api_error";
        yield* process.setExitCode(
          error instanceof HostedMutationDeclinedError
            ? 130
            : usage
              ? 2
              : Runtime.getErrorExitCode(error),
        );
        yield* output.raw(
          `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            code,
            status,
            message: Option.isSome(apiError)
              ? sanitizeInlineName(apiError.value.error.message)
              : normalized.message,
            hint:
              status === 401
                ? "Run supabase login for the selected profile."
                : status === 403
                  ? "Check the permissions listed in this command's help."
                  : (normalized.suggestion ?? null),
            ...(Option.isSome(apiError) ? { api_code: apiError.value.error.code } : {}),
            ...(normalized.entitlement ? { entitlement: normalized.entitlement } : {}),
          })}\n`,
          "stderr",
        );
      }),
    ),
  );
