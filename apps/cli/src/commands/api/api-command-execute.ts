import type { ApiClient, OperationId, OperationInput } from "@supabase/api/effect";
import { operationPermissions } from "@supabase/api/permissions";
import { Duration, Effect, Option, Predicate, Ref, Schedule, Schema } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Headers from "effect/http/Headers";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { planGateFromResponse, sanitizeErrorBody } from "../../command-internal/http-errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import { readPointer } from "./api-command-pointer.ts";
import { definitionOf, type ApiRequestPreview } from "./api-command-request.ts";
import { renderDryRunText, renderResponseText, singleLine } from "./api-command.format.ts";
import {
  ApiCommandOperationFailedError,
  ApiCommandStatusError,
  ApiCommandWaitTimeoutError,
} from "../../command-internal/command-errors/api-command.errors.ts";
import type { ApiCommandEntry, ApiCommandWait, ApiPollRead } from "./api-command.model.ts";

const POLL_BASE_DELAY = "1 second";
const POLL_MAX_DELAY_MILLIS = 10_000;

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const textDecoder = new TextDecoder();
const encodeJsonValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** How a generated command prints its result: the API's JSON untouched, or a human-readable rendering. */
export type ApiOutputFormat = "text" | "json";

/** Writes the request a dry run would send, as text or as a JSON document. */
export const writeDryRun = Effect.fnUntraced(function* (
  preview: ApiRequestPreview,
  format: ApiOutputFormat,
) {
  const output = yield* Output;
  return yield* output.raw(
    format === "text" ? renderDryRunText(preview) : `${encodeJsonValue(preview)}\n`,
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
  const body = Option.getOrUndefined(decodeJsonText(text));
  const fields = apiErrorFields(body);
  const { entitlement } = planGateFromResponse(response.status, text);
  return yield* new ApiCommandStatusError({
    status: response.status,
    message:
      fields.message === undefined || fields.message === ""
        ? `Unexpected status ${response.status}`
        : sanitizeErrorBody(fields.message),
    apiCode: fields.apiCode,
    hint:
      fields.hint === undefined
        ? entitlement === undefined
          ? statusHint(operationId, response.status)
          : undefined
        : sanitizeErrorBody(fields.hint),
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
 * fails with the API's own message, code and hint.
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

/**
 * Writes a success response. JSON bytes pass through untouched in machine output; a 2xx without a
 * body prints as `null` there and as `Done.` for a person.
 */
export const writeApiResponse = Effect.fnUntraced(function* (
  response: ApiCommandResponse,
  format: ApiOutputFormat,
) {
  const output = yield* Output;
  if (response.bytes.length === 0) {
    return yield* output.raw(format === "text" ? "Done.\n" : "null\n");
  }
  if (format === "json") return yield* output.rawBytes(response.bytes);
  const text = textDecoder.decode(response.bytes);
  const parsed = decodeJsonText(text);
  if (Option.isNone(parsed)) {
    const lines = text.endsWith("\n") ? text.slice(0, -1) : text;
    return yield* output.raw(`${lines.split("\n").map(singleLine).join("\n")}\n`);
  }
  return yield* output.raw(renderResponseText(parsed.value));
});

interface WaitInput {
  readonly api: ApiClient;
  readonly wait: ApiCommandWait;
  /** The operation the wait polls; its decoded input is `readInput`. */
  readonly readEntry: ApiPollRead;
  /** The command to name in a failure hint: the read's own, or the one that inspects a poll-only read. */
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

const classify = (wait: ApiCommandWait, read: PollRead, statusHint: string) => {
  const { response, body, status } = read;
  if (status !== undefined && wait.failed.includes(status)) {
    const reason =
      wait.error === undefined ? undefined : failureReason(readPointer(body, wait.error));
    return Effect.fail(
      new ApiCommandOperationFailedError({
        status,
        message: reason ?? `The operation failed with status "${status}".`,
        hint: statusHint,
      }),
    );
  }
  const done = status !== undefined && wait.succeeded.includes(status);
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
  const hint = `Check it with \`${statusCommand(input.statusEntry, input.ref, statusInput)}\`.`;
  const attempts = yield* Ref.make(0);
  const lastStatus = yield* Ref.make<string | null>(null);

  const poll = Ref.update(attempts, (count) => count + 1).pipe(
    Effect.andThen(sendApiRequest(input.api, readEntry, decoded)),
    Effect.flatMap((response) => {
      const read = readPoll(wait, response);
      return Ref.set(lastStatus, read.status ?? null).pipe(
        Effect.andThen(classify(wait, read, hint)),
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
                timeoutMillis: input.timeoutMillis,
                lastStatus: status,
                hint,
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
