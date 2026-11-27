import type { ApiClient, OperationId, OperationInput } from "@supabase/api/effect";
import { operationPermissions } from "@supabase/api/permissions";
import { DateTime, Duration, Effect, Option, Predicate, Ref, Schedule, Schema } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Headers from "effect/http/Headers";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { planGateFromResponse, sanitizeErrorBody } from "../../command-internal/http-errors.ts";
import { currentShellPlatform, shellQuoteArgument } from "../../command-internal/shell-quote.ts";
import { Output } from "../../shared/output/output.service.ts";
import type { OutputFormat } from "../../shared/output/types.ts";
import { readPointer } from "./api-command-pointer.ts";
import { definitionOf, type ApiRequestPreview } from "./api-command-request.ts";
import { renderDryRunText, renderResponseText, singleLine } from "./api-command.format.ts";
import {
  ApiCommandNetworkError,
  ApiCommandOperationFailedError,
  ApiCommandStatusError,
  ApiCommandUnexpectedResponseError,
  ApiCommandWaitTimeoutError,
} from "../../command-internal/command-errors/api-command.errors.ts";
import type { ApiCommandEntry, ApiCommandWait, ApiPollRead } from "./api-command.model.ts";

export const summaryText = (entry: Pick<ApiCommandEntry, "summary">): string =>
  entry.summary.replace(/\.$/, "");

/** A mutation the API accepted; failures after it describe its state, so none suggests running it again. */
export interface Acceptance {
  readonly action: string;
  /** The command that shows the state, when it is known. */
  readonly statusCommand?: string;
}

/** The acceptance a mutation's 2xx stands for; a read has none. */
export const acceptanceOf = (
  entry: Pick<ApiCommandEntry, "summary"> & Partial<Pick<ApiCommandEntry, "readOnly">>,
  statusCommand?: string,
): Acceptance | undefined =>
  entry.readOnly === false
    ? { action: summaryText(entry), ...(statusCommand === undefined ? {} : { statusCommand }) }
    : undefined;

const acceptedMessage = (accepted: Acceptance, failure: string): string =>
  `The API accepted the request (${accepted.action}), but ${failure}`;

const inspectSuggestion = ({ statusCommand }: Acceptance): string =>
  statusCommand === undefined
    ? "Check the current state before running the command again."
    : `Check the current state with \`${statusCommand}\` before running the command again.`;

const causeMessage = (cause: unknown): string | undefined =>
  cause instanceof Error && cause.message !== "" ? cause.message : undefined;

/**
 * A request that failed in transit: `stage` is `body` when the status line arrived and reading the
 * body failed. `accepted` is set when a mutation's 2xx came first.
 */
const networkError = (
  error: HttpClientError.HttpClientError,
  {
    mutation,
    accepted,
    stage,
  }: {
    readonly mutation: boolean;
    readonly accepted: Acceptance | undefined;
    readonly stage: "transport" | "body";
  },
) => {
  const { reason } = error;
  const detail =
    reason.description ??
    (reason._tag === "TransportError" ? causeMessage(reason.cause) : undefined);
  const cause = sanitizeErrorBody(detail ?? reason._tag);
  if (accepted !== undefined) {
    return new ApiCommandNetworkError({
      message: acceptedMessage(
        accepted,
        `the connection to the Management API failed afterwards (${cause}).`,
      ),
      suggestion: inspectSuggestion(accepted),
    });
  }
  return new ApiCommandNetworkError({
    message:
      stage === "body"
        ? `The Management API response could not be read (${cause}).`
        : `The Management API could not be reached (${cause}).`,
    suggestion: mutation
      ? "The request may have reached the API. Check the current state before running the command again."
      : "Check your network connection and run the command again.",
  });
};

const POLL_BASE_DELAY = "1 second";
const POLL_MAX_DELAY_MILLIS = 10_000;

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const lossyDecoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const decodeUtf8 = Option.liftThrowable((bytes: Uint8Array) => strictDecoder.decode(bytes));
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

/** Matches the typed client's request deadline, which also covers reading a 2xx body. */
const RESPONSE_BODY_TIMEOUT = Duration.seconds(60);

/** Reads a response body; a body that cannot be read in time is a transport failure. */
const readBytes = (response: HttpClientResponse.HttpClientResponse) =>
  response.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(
      (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: response.request, cause }),
        }),
    ),
    Effect.timeoutOrElse({
      duration: RESPONSE_BODY_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: response.request,
              description: "response body timed out",
            }),
          }),
        ),
    }),
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
  after: Acceptance | undefined,
  own: Acceptance | undefined,
) {
  const text = lossyDecoder.decode(
    yield* readBytes(response).pipe(Effect.orElseSucceed(() => new Uint8Array())),
  );
  const body = Option.getOrUndefined(decodeJsonText(text));
  const fields = apiErrorFields(body);
  const { entitlement } = planGateFromResponse(response.status, text);
  const ownHint = fields.hint === undefined ? undefined : sanitizeErrorBody(fields.hint);
  const message =
    fields.message === undefined || fields.message === ""
      ? `Unexpected status ${response.status}`
      : `${sanitizeErrorBody(fields.message)} (HTTP ${response.status})`;
  const hasOwnHint = ownHint !== undefined && ownHint.trim() !== "";
  return yield* new ApiCommandStatusError({
    status: response.status,
    message:
      after === undefined ? message : acceptedMessage(after, `reading it failed: ${message}`),
    suggestion: hasOwnHint
      ? ownHint
      : entitlement !== undefined
        ? undefined
        : (statusHint(operationId, response.status) ??
          (after === undefined
            ? response.status >= 500 && own !== undefined
              ? `The request may have reached the API. ${inspectSuggestion(own)}`
              : undefined
            : inspectSuggestion(after))),
    ...(entitlement === undefined ? {} : { entitlement }),
  });
});

/** A 2xx response of an executed operation, with its body read once. */
export interface ApiCommandResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly headers: Headers.Headers;
}

/** The operation a request runs; `readOnly` is known for generated commands, not for hidden poll reads. */
type ApiRequestEntry = ApiPollRead & Partial<Pick<ApiCommandEntry, "readOnly">>;

/**
 * Sends the decoded input of `entry` through `api` and returns the 2xx response; any other status
 * fails with the API's own message and hint, and a transport failure with a network error. `after`
 * is the mutation a follow-up read comes after: all its failures say the API accepted the change.
 * `acceptance` is what this request's own 2xx stands for, so only failures after the status line
 * say so; it defaults to {@link acceptanceOf} the entry.
 */
export const sendApiRequest = Effect.fnUntraced(function* (
  api: ApiClient,
  entry: ApiRequestEntry,
  decoded: OperationInput<OperationId>,
  {
    after,
    acceptance = acceptanceOf(entry),
  }: {
    readonly after?: Acceptance | undefined;
    readonly acceptance?: Acceptance | undefined;
  } = {},
) {
  const mutation = entry.readOnly === false;
  const accepted = after ?? acceptance;
  const response = yield* api
    .executeRaw<OperationId>(definitionOf(entry), decoded)
    .pipe(
      Effect.catchTag("HttpClientError", (error) =>
        Effect.fail(networkError(error, { mutation, accepted: after, stage: "transport" })),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* statusError(entry.operationId, response, after, acceptance);
  }
  const bytes = yield* readBytes(response).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      Effect.fail(networkError(error, { mutation, accepted, stage: "body" })),
    ),
  );
  const result: ApiCommandResponse = { status: response.status, bytes, headers: response.headers };
  return result;
});

const parseResponse = (response: ApiCommandResponse): unknown =>
  Option.getOrUndefined(Option.flatMap(decodeUtf8(response.bytes), decodeJsonText));

const invalidJsonResponse = (accepted: Acceptance | undefined) =>
  accepted === undefined
    ? new ApiCommandUnexpectedResponseError({
        message: "The API returned a success response that is not valid JSON.",
        suggestion: "Retry the command; if it keeps failing, report it with the command you ran.",
      })
    : new ApiCommandUnexpectedResponseError({
        message: acceptedMessage(accepted, "its response is not valid JSON."),
        suggestion: inspectSuggestion(accepted),
      });

/**
 * Writes a success response. Machine output requires valid JSON: json passes the bytes through
 * untouched and stream-json wraps the parsed value in a result frame; a 2xx without a body is
 * `null` there and `Done.` for a person. `accepted` is the mutation the response answers.
 */
export const writeApiResponse = Effect.fnUntraced(function* (
  response: ApiCommandResponse,
  format: OutputFormat,
  accepted?: Acceptance,
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
  const strictText = decodeUtf8(response.bytes);
  const text = Option.getOrElse(strictText, () => lossyDecoder.decode(response.bytes));
  const parsed = Option.flatMap(strictText, decodeJsonText);
  if (format === "text") {
    if (Option.isNone(parsed)) {
      const lines = text.endsWith("\n") ? text.slice(0, -1) : text;
      return yield* output.raw(`${lines.split("\n").map(singleLine).join("\n")}\n`);
    }
    return yield* output.raw(renderResponseText(parsed.value));
  }
  if (Option.isNone(parsed)) return yield* invalidJsonResponse(accepted);
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
  /** The mutation whose change response the wait follows; absent for a read that polls itself. */
  readonly accepted?: Acceptance | undefined;
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

const noStatus = (wait: ApiCommandWait, after: Acceptance | undefined): string => {
  const message = `${wait.read} returned no status at ${wait.status}.`;
  return after === undefined ? message : acceptedMessage(after, message);
};

const timeoutMessage = (
  wait: ApiCommandWait,
  status: string | null,
  after: Acceptance | undefined,
): string => {
  const report = `${wait.read} to report ${wait.succeeded.join(" or ")}`;
  const last = `Last observed status: ${status === null ? "unavailable" : sanitizeErrorBody(status)}.`;
  return after === undefined
    ? `Timed out waiting for ${report}. ${last}`
    : acceptedMessage(after, `the wait for ${report} timed out. ${last}`);
};

const classify = (
  wait: ApiCommandWait,
  read: PollRead,
  statusHint: string,
  after: Acceptance | undefined,
): Effect.Effect<
  PollOutcome,
  ApiCommandOperationFailedError | ApiCommandUnexpectedResponseError
> => {
  const { response, body, status } = read;
  if (status === undefined) {
    return Effect.fail(
      new ApiCommandUnexpectedResponseError({
        message: noStatus(wait, after),
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
  const quoted = (value: unknown) => shellQuoteArgument(String(value), currentShellPlatform());
  const positional = readEntry.bindings.flatMap((binding) => {
    const value = valueOf(binding);
    return binding.source === "argument" && value !== undefined ? [quoted(value)] : [];
  });
  const flags = readEntry.bindings.flatMap((binding) => {
    const value = valueOf(binding);
    return binding.source === "flag" && value !== undefined
      ? [`--${binding.flag} ${quoted(value)}`]
      : [];
  });
  return ["supabase", ...readEntry.command, ...positional, ...flags, `--remote=${ref}`].join(" ");
};

/** The command that shows `entry`'s state when it needs nothing beyond the project ref. */
export const refOnlyStatusCommand = (entry: ApiCommandEntry, ref: string): string | undefined =>
  entry.bindings.some(
    (binding) =>
      binding.source === "argument" ||
      (binding.source === "flag" &&
        entry.flags.some((flag) => flag.required && flag.name === binding.flag)),
  )
    ? undefined
    : statusCommand(entry, ref, {});

/**
 * The input of a linked wait's read: the project ref plus each read parameter taken from the
 * change response by pointer. A response that lacks one fails as an unexpected response of the
 * accepted change.
 */
export const linkedReadInput = Effect.fnUntraced(function* (input: {
  readonly wait: ApiCommandWait;
  readonly ref: string;
  readonly changed: ApiCommandResponse;
  readonly accepted: Acceptance;
}) {
  const changedBody = parseResponse(input.changed);
  const readInput: Record<string, unknown> = { ref: input.ref };
  for (const [param, pointer] of Object.entries(input.wait.params)) {
    const value = readPointer(changedBody, pointer);
    if (value === undefined || value === null) {
      return yield* new ApiCommandUnexpectedResponseError({
        message: acceptedMessage(
          input.accepted,
          `its response did not include ${pointer}, which the wait needs.`,
        ),
        suggestion: inspectSuggestion(input.accepted),
      });
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
  const rejectedCommand = refOnlyStatusCommand(input.statusEntry, input.ref);
  const decoded = yield* Schema.decodeEffect(definitionOf(readEntry).inputSchema, {
    onExcessProperty: "error",
  })(readInput).pipe(
    Effect.catchTag("SchemaError", (error) => {
      const { accepted } = input;
      if (accepted === undefined) return Effect.die(error);
      const rejected: Acceptance =
        rejectedCommand === undefined
          ? { action: accepted.action }
          : { action: accepted.action, statusCommand: rejectedCommand };
      return Effect.fail(
        new ApiCommandUnexpectedResponseError({
          message: acceptedMessage(
            rejected,
            `its response held a value that ${wait.read} does not accept.`,
          ),
          suggestion: inspectSuggestion(rejected),
        }),
      );
    }),
  );
  const statusInput = input.statusEntry.operationId === readEntry.operationId ? readInput : {};
  const command = statusCommand(input.statusEntry, input.ref, statusInput);
  const suggestion = `Check it with \`${command}\`.`;
  const after: Acceptance | undefined =
    input.accepted === undefined ? undefined : { ...input.accepted, statusCommand: command };
  const attempts = yield* Ref.make(0);
  const lastStatus = yield* Ref.make<string | null>(null);

  const poll = Ref.update(attempts, (count) => count + 1).pipe(
    Effect.andThen(sendApiRequest(input.api, readEntry, decoded, { after })),
    Effect.flatMap((response) => {
      const read = readPoll(wait, response);
      return Ref.getAndSet(lastStatus, read.status ?? null).pipe(
        Effect.flatMap((previous) =>
          classify(wait, read, suggestion, after).pipe(
            Effect.tap(() =>
              previous === read.status ? Effect.void : (input.onPoll?.(read.status) ?? Effect.void),
            ),
          ),
        ),
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
                message: timeoutMessage(wait, status, after),
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
