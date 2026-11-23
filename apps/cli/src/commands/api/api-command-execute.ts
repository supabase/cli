import type { ApiClient, OperationId, OperationInput } from "@supabase/api/effect";
import { operationPermissions } from "@supabase/api/permissions";
import { DateTime, Duration, Effect, Option, Predicate, Ref, Schedule, Schema } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Headers from "effect/http/Headers";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { planGateFromResponse, sanitizeErrorBody } from "../../command-internal/http-errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import type { OutputFormat } from "../../shared/output/types.ts";
import { readPointer } from "./api-command-pointer.ts";
import { definitionOf, type ApiRequestPreview } from "./api-command-request.ts";
import { renderDryRunText, renderResponseText, singleLine } from "./api-command.format.ts";
import {
  ApiCommandOperationFailedError,
  ApiCommandStatusError,
  ApiCommandUnexpectedResponseError,
  ApiCommandWaitTimeoutError,
} from "../../command-internal/command-errors/api-command.errors.ts";
import type { ApiCommandEntry, ApiCommandWait, ApiPollRead } from "./api-command.model.ts";

const POLL_BASE_DELAY = "1 second";
const POLL_MAX_DELAY_MILLIS = 10_000;

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const textDecoder = new TextDecoder();
const encodeJsonValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Emits the `{type:"result"}` frame of a stream-json run. `Output.result` would merge the announced
 * target into object data, which the json document never carries.
 */
const writeResultFrame = Effect.fnUntraced(function* (data: unknown) {
  const output = yield* Output;
  return yield* output.event({
    type: "result",
    data,
    timestamp: DateTime.formatIso(yield* DateTime.now),
  });
});

/** Writes the request a dry run would send: a text preview, the JSON document, or a result frame. */
export const writeDryRun = Effect.fnUntraced(function* (
  preview: ApiRequestPreview,
  format: OutputFormat,
) {
  const output = yield* Output;
  switch (format) {
    case "text":
      return yield* output.raw(renderDryRunText(preview));
    case "json":
      return yield* output.raw(`${encodeJsonValue(preview)}\n`);
    case "stream-json":
      return yield* writeResultFrame(preview);
  }
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
  const body = Option.getOrUndefined(decodeJsonText(text));
  const fields = apiErrorFields(body);
  const { entitlement } = planGateFromResponse(response.status, text);
  const ownHint = fields.hint === undefined ? undefined : sanitizeErrorBody(fields.hint);
  return yield* new ApiCommandStatusError({
    status: response.status,
    message:
      fields.message === undefined || fields.message === ""
        ? `Unexpected status ${response.status}`
        : `${sanitizeErrorBody(fields.message)} (HTTP ${response.status})`,
    suggestion:
      ownHint === undefined || ownHint.trim() === ""
        ? entitlement === undefined
          ? statusHint(operationId, response.status)
          : undefined
        : ownHint,
    ...(entitlement === undefined ? {} : { entitlement }),
  });
});

/** A 2xx response of an executed operation, with its body read once. */
export interface ApiCommandResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly headers: Headers.Headers;
}

/**
 * Sends the decoded input of `entry` through `api` and returns the 2xx response; any other status
 * fails with the API's own message and hint.
 */
export const sendApiRequest = Effect.fnUntraced(function* (
  api: ApiClient,
  entry: Pick<ApiCommandEntry, "definition" | "operationId">,
  decoded: OperationInput<OperationId>,
) {
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

const invalidJsonResponse = () =>
  new ApiCommandUnexpectedResponseError({
    message: "The API returned a success response that is not valid JSON.",
    suggestion: "Retry the command; if it keeps failing, report it with the command you ran.",
  });

/**
 * Writes a success response. Machine output requires valid JSON: json passes the bytes through
 * untouched and stream-json wraps the parsed value in a result frame; a 2xx without a body is
 * `null` there and `Done.` for a person.
 */
export const writeApiResponse = Effect.fnUntraced(function* (
  response: ApiCommandResponse,
  format: OutputFormat,
) {
  const output = yield* Output;
  if (response.bytes.length === 0) {
    switch (format) {
      case "text":
        return yield* output.raw("Done.\n");
      case "json":
        return yield* output.raw("null\n");
      case "stream-json":
        return yield* writeResultFrame(null);
    }
  }
  const text = textDecoder.decode(response.bytes);
  const parsed = decodeJsonText(text);
  if (format === "text") {
    if (Option.isNone(parsed)) {
      const lines = text.endsWith("\n") ? text.slice(0, -1) : text;
      return yield* output.raw(`${lines.split("\n").map(singleLine).join("\n")}\n`);
    }
    return yield* output.raw(renderResponseText(parsed.value));
  }
  if (Option.isNone(parsed)) return yield* invalidJsonResponse();
  return format === "json"
    ? yield* output.rawBytes(response.bytes)
    : yield* writeResultFrame(parsed.value);
});

interface WaitInput {
  readonly api: ApiClient;
  readonly wait: ApiCommandWait;
  /** The operation the wait polls; its decoded input is `readInput`. */
  readonly readEntry: ApiPollRead;
  /** The command to name in a failure suggestion: the read's own, or the one that inspects a poll-only read. */
  readonly statusEntry: ApiCommandEntry;
  /** The flat input of the read operation, as assembled from flags or the change response. */
  readonly readInput: Readonly<Record<string, unknown>>;
  readonly ref: string;
  readonly timeoutMillis: number;
  /** Called after each successful poll with the status it read. */
  readonly onPoll?: (status: string | undefined) => Effect.Effect<void>;
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

/** One poll read: the response, its decoded JSON body and the status the wait reads from it. */
interface PollRead {
  readonly response: ApiCommandResponse;
  readonly body: unknown;
  readonly status: string | undefined;
}

const readPoll = (wait: ApiCommandWait, response: ApiCommandResponse): PollRead => {
  const body = parseResponse(response);
  const status = readPointer(body, wait.status);
  return { response, body, status: typeof status === "string" ? status : undefined };
};

const classify = (
  wait: ApiCommandWait,
  read: PollRead,
  statusHint: string,
): Effect.Effect<
  PollOutcome,
  ApiCommandOperationFailedError | ApiCommandUnexpectedResponseError
> => {
  const { response, body, status } = read;
  if (status === undefined) {
    return Effect.fail(
      new ApiCommandUnexpectedResponseError({
        message: `${wait.read} returned no status at ${wait.status}.`,
        suggestion: statusHint,
      }),
    );
  }
  if (wait.failed.includes(status)) {
    const reason =
      wait.error === undefined ? undefined : failureReason(readPointer(body, wait.error));
    return Effect.fail(
      new ApiCommandOperationFailedError({
        status,
        message: reason ?? `The operation failed with status "${status}".`,
        suggestion: statusHint,
      }),
    );
  }
  const done = wait.succeeded.includes(status);
  return Effect.succeed<PollOutcome>({ done, response });
};

/** The command that re-reads the operation's state, built from the values the wait polls with. */
const statusCommand = (
  readEntry: ApiCommandEntry,
  ref: string,
  readInput: Readonly<Record<string, unknown>>,
): string => {
  const valueOf = (binding: { readonly name: string }) => readInput[binding.name];
  const positional = readEntry.bindings.flatMap((binding) => {
    const value = valueOf(binding);
    return binding.source === "argument" && value !== undefined ? [String(value)] : [];
  });
  const flags = readEntry.bindings.flatMap((binding) => {
    const value = valueOf(binding);
    return binding.source === "flag" && value !== undefined
      ? [`--${binding.flag} ${String(value)}`]
      : [];
  });
  return ["supabase", ...readEntry.command, ...positional, ...flags, `--remote=${ref}`].join(" ");
};

/**
 * The input of a linked wait's read: the project ref plus each read parameter taken from the
 * change response by pointer. Generation guarantees the response carries them, so a missing one
 * is a defect.
 */
export const linkedReadInput = Effect.fnUntraced(function* (input: {
  readonly wait: ApiCommandWait;
  /** The operation that produced `changed`. */
  readonly changedOperationId: string;
  readonly ref: string;
  readonly changed: ApiCommandResponse;
}) {
  const changedBody = parseResponse(input.changed);
  const readInput: Record<string, unknown> = { ref: input.ref };
  for (const [param, pointer] of Object.entries(input.wait.params)) {
    const value = readPointer(changedBody, pointer);
    if (value === undefined || value === null) {
      return yield* Effect.die(
        new Error(
          `${input.changedOperationId} did not return ${pointer}, which ${input.wait.read} needs to wait.`,
        ),
      );
    }
    readInput[param] = value;
  }
  return readInput;
});

/**
 * Polls the read operation until it reports a terminal status and returns the final response. A
 * failed status, a timeout, or any non-2xx read (a 409 included) ends the wait with an error; the
 * failure reason only supplies its message.
 */
export const waitForOperation = Effect.fn("api-command.wait")(function* (input: WaitInput) {
  const { wait, readEntry, readInput } = input;
  const decoded = yield* Schema.decodeEffect(definitionOf(readEntry).inputSchema, {
    onExcessProperty: "error",
  })(readInput).pipe(Effect.orDie);
  const statusInput = input.statusEntry.operationId === readEntry.operationId ? readInput : {};
  const suggestion = `Check it with \`${statusCommand(input.statusEntry, input.ref, statusInput)}\`.`;
  const attempts = yield* Ref.make(0);
  const lastStatus = yield* Ref.make<string | null>(null);

  const poll = Ref.update(attempts, (count) => count + 1).pipe(
    Effect.andThen(sendApiRequest(input.api, readEntry, decoded)),
    Effect.flatMap((response) => {
      const read = readPoll(wait, response);
      return Ref.set(lastStatus, read.status ?? null).pipe(
        Effect.andThen(classify(wait, read, suggestion)),
        Effect.tap(() => input.onPoll?.(read.status) ?? Effect.void),
      );
    }),
    Effect.withTracerEnabled(false),
  );

  const outcome = yield* poll.pipe(
    Effect.repeat({ schedule: pollSchedule, until: (result) => result.done }),
    Effect.timeoutOrElse({
      duration: input.timeoutMillis,
      orElse: () =>
        Ref.get(lastStatus).pipe(
          Effect.flatMap((status) =>
            Effect.fail(
              new ApiCommandWaitTimeoutError({
                message: `Timed out waiting for ${wait.read} to report ${wait.succeeded.join(" or ")}. Last observed status: ${status === null ? "unavailable" : sanitizeErrorBody(status)}.`,
                suggestion,
              }),
            ),
          ),
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
  return outcome.response;
});
