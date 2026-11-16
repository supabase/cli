import type { OperationId, OperationInput } from "@supabase/api/effect";
import { operationPermissions } from "@supabase/api/permissions";
import { Duration, Effect, Option, Predicate, Ref, Schedule, Schema } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Headers from "effect/http/Headers";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { sanitizeErrorBody } from "../../command-internal/http-errors.ts";
import { encodeStructYaml, shapeAny } from "../../command-internal/struct-output.encoders.ts";
import { Output } from "../../shared/output/output.service.ts";
import { readPointer } from "./api-command-pointer.ts";
import { decodeInput, definitionOf } from "./api-command-request.ts";
import {
  ApiCommandOperationFailedError,
  ApiCommandStatusError,
  ApiCommandWaitTimeoutError,
} from "./api-command.errors.ts";
import type { ApiCommandEntry, ApiCommandWait } from "./api-command.model.ts";
import { apiCommands } from "./generated.ts";

const POLL_BASE_DELAY = "1 second";
const POLL_MAX_DELAY_MILLIS = 10_000;

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const textDecoder = new TextDecoder();
const encodeJsonValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** How a generated command prints its result: the API's JSON untouched, or the same document as YAML. */
export type ApiOutputFormat = "json" | "yaml";

/** Writes `value` as one document in `format`. */
export const writeDocument = Effect.fnUntraced(function* (value: unknown, format: ApiOutputFormat) {
  const output = yield* Output;
  return yield* output.raw(
    format === "yaml" ? encodeStructYaml(value, shapeAny) : `${encodeJsonValue(value)}\n`,
  );
});

const stringField = (source: unknown, key: string): string | undefined => {
  if (!Predicate.isObject(source)) return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" ? value : undefined;
};

/** Reads a response body; a body that cannot be read is a transport failure. */
const readBytes = (response: HttpClientResponse.HttpClientResponse) =>
  response.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(
      (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: response.request, cause }),
        }),
    ),
  );

const permissionHint = (operationId: string): string | undefined => {
  const sets = operationPermissions[operationId]?.fga ?? [];
  if (sets.length === 0) return undefined;
  const alternatives = sets.map((set) => set.join(" + ")).join(" or ");
  return `Your token needs the permissions: ${alternatives}.`;
};

const statusHint = (operationId: string, status: number): string | undefined =>
  status === 401
    ? "Run `supabase login`"
    : status === 403
      ? permissionHint(operationId)
      : undefined;

/**
 * The error fields of a Management API failure body: v2 nests `{code, message, description?}`
 * under `error`, v1 puts `message` (and sometimes `code`, `hint`) at the top level.
 */
const apiErrorFields = (body: unknown) => {
  const nested = Predicate.isObject(body) ? Reflect.get(body, "error") : undefined;
  const source = Predicate.isObject(nested) ? nested : body;
  const message = stringField(source, "message");
  const description = stringField(source, "description");
  return {
    message:
      message === undefined || message === ""
        ? description
        : description === undefined || description === ""
          ? message
          : `${message}: ${description}`,
    apiCode: stringField(source, "code"),
    hint: stringField(source, "hint"),
  };
};

const statusError = Effect.fnUntraced(function* (
  operationId: string,
  response: HttpClientResponse.HttpClientResponse,
) {
  const text = textDecoder.decode(
    yield* readBytes(response).pipe(Effect.orElseSucceed(() => new Uint8Array())),
  );
  const fields = apiErrorFields(Option.getOrUndefined(decodeJsonText(text)));
  return yield* new ApiCommandStatusError({
    status: response.status,
    message:
      fields.message === undefined || fields.message === ""
        ? `Unexpected status ${response.status}`
        : sanitizeErrorBody(fields.message),
    apiCode: fields.apiCode,
    hint: fields.hint ?? statusHint(operationId, response.status),
  });
});

/** A 2xx response of an executed operation, with its body read once. */
export interface ApiCommandResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly headers: Headers.Headers;
}

/**
 * Sends the decoded input of `entry` and returns the 2xx response; any other status fails with
 * the API's own message, code and hint.
 */
export const sendApiRequest = Effect.fnUntraced(function* (
  entry: ApiCommandEntry,
  decoded: OperationInput<OperationId>,
) {
  const api = yield* CommandPlatformApi;
  const response = yield* api.executeRaw<OperationId>(definitionOf(entry), decoded);
  if (response.status < 200 || response.status >= 300) {
    return yield* statusError(entry.operationId, response);
  }
  const result: ApiCommandResponse = {
    status: response.status,
    bytes: yield* readBytes(response),
    headers: response.headers,
  };
  return result;
});

const parseResponse = (response: ApiCommandResponse): unknown =>
  Option.getOrUndefined(decodeJsonText(textDecoder.decode(response.bytes)));

/**
 * Writes a success response. `json` passes JSON bytes through untouched, prints text as a JSON
 * string and an empty body as `null`; `yaml` encodes that same document.
 */
export const writeApiResponse = Effect.fnUntraced(function* (
  entry: ApiCommandEntry,
  response: ApiCommandResponse,
  format: ApiOutputFormat,
) {
  const hasBody = response.bytes.length > 0;
  const text = textDecoder.decode(response.bytes);
  if (format === "json" && entry.response.kind === "json" && hasBody) {
    const output = yield* Output;
    return yield* output.rawBytes(response.bytes);
  }
  const document =
    !hasBody || entry.response.kind === "empty"
      ? null
      : entry.response.kind === "text"
        ? text
        : Option.getOrElse(decodeJsonText(text), () => text);
  return yield* writeDocument(document, format);
});

interface WaitInput {
  readonly wait: ApiCommandWait;
  /** The operation that produced `changed`. */
  readonly changedEntry: ApiCommandEntry;
  readonly ref: string;
  /** The change response the read parameters are taken from. */
  readonly changed: ApiCommandResponse;
  readonly timeoutMillis: number;
}

export interface PollOutcome {
  readonly done: boolean;
  readonly response: ApiCommandResponse;
}

/** The delay a `Retry-After` header asks for, as delta-seconds or an HTTP date. */
const retryAfterMillis = (headers: Headers.Headers, now: number): number | undefined => {
  const value = Option.getOrUndefined(Headers.get(headers, "retry-after"))?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/u.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

/** Backoff from 1s doubling to a 10s cap; a longer `Retry-After` on the last read wins. */
export const pollSchedule = Schedule.exponential(POLL_BASE_DELAY).pipe(
  Schedule.setInputType<PollOutcome>(),
  Schedule.modifyDelay(({ input, duration, now }) =>
    Effect.succeed(
      Math.max(
        Math.min(Duration.toMillis(duration), POLL_MAX_DELAY_MILLIS),
        retryAfterMillis(input.response.headers, now) ?? 0,
      ),
    ),
  ),
);

const failureReason = (reason: unknown): string | undefined => {
  if (reason === undefined || reason === null || reason === "") return undefined;
  return sanitizeErrorBody(typeof reason === "string" ? reason : encodeJsonValue(reason));
};

const classify = (wait: ApiCommandWait, response: ApiCommandResponse, statusHint: string) => {
  const body = parseResponse(response);
  const status = readPointer(body, wait.status);
  const reason =
    wait.error === undefined ? undefined : failureReason(readPointer(body, wait.error));
  const failedStatus = typeof status === "string" && wait.failed.includes(status);
  if (reason !== undefined || failedStatus) {
    return Effect.fail(
      new ApiCommandOperationFailedError({
        status: typeof status === "string" ? status : "unknown",
        message: reason ?? `The operation failed with status "${String(status)}".`,
        hint: statusHint,
      }),
    );
  }
  const done = typeof status === "string" && wait.succeeded.includes(status);
  return Effect.succeed<PollOutcome>({ done, response });
};

/** The command that re-reads the operation's state, built from the values the wait polls with. */
const statusCommand = (
  readEntry: ApiCommandEntry,
  ref: string,
  readInput: Readonly<Record<string, unknown>>,
): string => {
  const flags = readEntry.bindings.flatMap((binding) => {
    if (binding.source !== "flag") return [];
    const value = readInput[binding.name];
    return value === undefined ? [] : [`--${binding.flag} ${String(value)}`];
  });
  return ["supabase", ...readEntry.command, ...flags, `--remote=${ref}`].join(" ");
};

/**
 * Polls the read operation until it reports a terminal status and returns the final response with
 * the operation that produced it. A failed status or failure reason, a timeout, or any non-2xx
 * read (a 409 included) ends the wait with an error. A change response that lacks a value the
 * read needs is returned as it is, without waiting.
 */
export const waitForOperation = Effect.fn("api-command.wait")(function* (input: WaitInput) {
  const { wait } = input;
  const readEntry = apiCommands.find((candidate) => candidate.operationId === wait.read);
  if (readEntry === undefined) {
    return yield* Effect.die(new Error(`Unknown wait read operation ${wait.read}`));
  }
  const changedBody = parseResponse(input.changed);
  const readInput: Record<string, unknown> = { ref: input.ref };
  for (const [param, pointer] of Object.entries(wait.params)) {
    const value = readPointer(changedBody, pointer);
    if (value === undefined) {
      yield* Effect.annotateCurrentSpan({ "wait.outcome": "skipped" });
      return { entry: input.changedEntry, response: input.changed };
    }
    readInput[param] = value;
  }
  const decoded = yield* decodeInput(readEntry, readInput);
  const hint = `Check it with \`${statusCommand(readEntry, input.ref, readInput)}\`.`;
  const attempts = yield* Ref.make(0);

  const poll = Ref.update(attempts, (count) => count + 1).pipe(
    Effect.andThen(sendApiRequest(readEntry, decoded)),
    Effect.flatMap((response) => classify(wait, response, hint)),
    Effect.withTracerEnabled(false),
  );

  const outcome = yield* poll.pipe(
    Effect.repeat({ schedule: pollSchedule, until: (result) => result.done }),
    Effect.timeoutOrElse({
      duration: input.timeoutMillis,
      orElse: () =>
        Effect.fail(
          new ApiCommandWaitTimeoutError({
            message: `Timed out waiting for ${wait.read} to report ${wait.succeeded.join(" or ")}.`,
            timeoutMillis: input.timeoutMillis,
            hint,
          }),
        ),
    }),
    Effect.tapError((error) =>
      Ref.get(attempts).pipe(
        Effect.flatMap((count) =>
          Effect.annotateCurrentSpan({ "wait.attempts": count, "wait.outcome": error._tag }),
        ),
      ),
    ),
  );
  yield* Effect.annotateCurrentSpan({
    "wait.attempts": yield* Ref.get(attempts),
    "wait.outcome": "succeeded",
  });
  return { entry: readEntry, response: outcome.response };
});
