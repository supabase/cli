import { styleText } from "node:util";

import { Cause, Effect, Option, Predicate, Stdio } from "effect";
import { CliError, type Command } from "effect/cli";
import * as HttpClientError from "effect/http/HttpClientError";
import { InvalidAccessTokenError, AccessTokenRequiredError } from "../../auth/errors.ts";
import {
  readCommandErrorsContract,
  type CommandErrorsContract,
} from "../../command-internal/command-errors/command-errors.annotation.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "../../command-internal/hosted-consent/hosted-consent.errors.ts";
import {
  ApiCommandOperationFailedError,
  ApiCommandStatusError,
  ApiCommandUsageError,
  ApiCommandWaitTimeoutError,
} from "../../commands/api/api-command.errors.ts";
import { normalizeCause } from "../output/normalize-error.ts";
import { writeStdio } from "../output/output.layer.ts";
import {
  classifyCliErrorActionability,
  CliErrorCategory,
  CliErrorKind,
} from "../telemetry/error-actionability.ts";
import { isMachineResourceFormat } from "../output/resource-format.ts";
import { readLongFlag, readOutputFlag } from "./agent-output.ts";
import {
  findCommand,
  resolvedCommandPathForArgv,
  type CliErrorSuggestionContext,
} from "./subcommand-flag-suggestions.ts";

/** The closed set of failure codes an `errors.standard` command reports. */
type StandardErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "invalid_input"
  | "api_error"
  | "network_error"
  | "usage_error"
  | "operation_failed"
  | "wait_timeout"
  | "cancelled"
  | "internal_error";

/** The failure document an `errors.standard` command writes as the last line of stderr. */
interface StandardErrorDocument {
  readonly code: StandardErrorCode;
  readonly status: number | null;
  readonly message: string;
  readonly hint: string | null;
  readonly api_code?: string;
  readonly context?: Readonly<Record<string, string | number>>;
}

/** A mapped failure: the process exit code and the document to report. */
export interface StandardFailure {
  readonly exitCode: number;
  readonly document: StandardErrorDocument;
}

/** A standard failure waiting to be written once the run has finished its cleanup. */
export interface PendingStandardFailure extends StandardFailure {
  readonly machine: boolean;
}

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_CANCELLED = 130;

const documentForStatus = (
  status: number,
  message: string,
  extras: { readonly apiCode?: string | undefined; readonly hint?: string | undefined },
): StandardErrorDocument => {
  const code: StandardErrorCode =
    status === 400 || status === 422
      ? "invalid_input"
      : status === 401
        ? "unauthenticated"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not_found"
            : status === 409
              ? "conflict"
              : status === 429
                ? "rate_limited"
                : "api_error";
  return {
    code,
    status,
    message,
    hint: extras.hint ?? null,
    ...(extras.apiCode === undefined ? {} : { api_code: extras.apiCode }),
  };
};

const failure = (
  exitCode: number,
  code: StandardErrorCode,
  message: string,
  hint: string | null = null,
  extras: Pick<StandardErrorDocument, "context"> = {},
): StandardFailure => ({
  exitCode,
  document: { code, status: null, message, hint, ...extras },
});

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;

const failureForError = (
  error: unknown,
  cause: Cause.Cause<unknown>,
  context: CliErrorSuggestionContext | undefined,
): StandardFailure => {
  if (Predicate.isTagged(error, "UserError") && "cause" in error && error.cause !== undefined) {
    return failureForError(error.cause, cause, context);
  }
  if (error instanceof ApiCommandStatusError) {
    return {
      exitCode: EXIT_FAILURE,
      document: documentForStatus(error.status, error.message, error),
    };
  }
  if (error instanceof ApiCommandUsageError) {
    return failure(EXIT_USAGE, "usage_error", error.message, error.hint ?? null);
  }
  if (error instanceof HostedMutationConsentRequiredError) {
    return failure(EXIT_USAGE, "usage_error", error.message, "Pass --yes");
  }
  if (error instanceof HostedMutationDeclinedError) {
    return failure(EXIT_CANCELLED, "cancelled", error.message);
  }
  if (error instanceof ApiCommandOperationFailedError) {
    return failure(EXIT_FAILURE, "operation_failed", error.message, error.hint, {
      context: { status: error.status },
    });
  }
  if (error instanceof ApiCommandWaitTimeoutError) {
    return failure(EXIT_FAILURE, "wait_timeout", error.message, error.hint, {
      context: { timeout_ms: error.timeoutMillis },
    });
  }
  if (error instanceof AccessTokenRequiredError || error instanceof InvalidAccessTokenError) {
    return failure(EXIT_FAILURE, "unauthenticated", error.message);
  }
  if (Predicate.isTagged(error, "SupabaseApiConfigError")) {
    return failure(EXIT_FAILURE, "unauthenticated", messageOf(error, "Missing access token"));
  }
  if (HttpClientError.isHttpClientError(error)) {
    const status = error.response?.status;
    return {
      exitCode: EXIT_FAILURE,
      document:
        status === undefined
          ? error.reason._tag === "DecodeError" || error.reason._tag === "EmptyBodyError"
            ? failure(EXIT_FAILURE, "api_error", error.message).document
            : failure(EXIT_FAILURE, "network_error", error.message).document
          : documentForStatus(status, error.message, {}),
    };
  }
  if (CliError.isCliError(error)) {
    const normalized = normalizeCause(cause, context);
    return failure(EXIT_USAGE, "usage_error", normalized.message, normalized.suggestion ?? null);
  }
  const declared = classifyCliErrorActionability(error);
  if (
    declared.error_kind === CliErrorKind.UserActionable &&
    declared.error_category === CliErrorCategory.InvalidInput
  ) {
    const normalized = normalizeCause(cause, context);
    return failure(EXIT_USAGE, "usage_error", normalized.message, normalized.suggestion ?? null);
  }
  return failure(EXIT_FAILURE, "internal_error", normalizeCause(cause).message);
};

/** Maps a failure cause to the exit code and document `errors.standard` commands report. */
export const standardFailureFor = (
  cause: Cause.Cause<unknown>,
  context?: CliErrorSuggestionContext,
): StandardFailure => {
  if (Cause.hasInterruptsOnly(cause)) {
    return failure(EXIT_CANCELLED, "cancelled", "Interrupted");
  }
  const error = Option.getOrElse(Cause.findErrorOption(cause), () => Cause.squash(cause));
  return failureForError(error, cause, context);
};

/** The mounted command node a run resolves to: the longest subcommand prefix of the argv's positionals. */
const resolveCommandNode = (
  rootCommand: Command.Command.Any,
  positionals: ReadonlyArray<string>,
): Command.Command.Any | undefined =>
  findCommand(rootCommand, resolvedCommandPathForArgv(rootCommand, positionals).slice(1));

/** The failure contract the run's resolved command node declares. */
export const errorsContractForRun = (
  rootCommand: Command.Command.Any,
  positionals: ReadonlyArray<string>,
): CommandErrorsContract => {
  const node = resolveCommandNode(rootCommand, positionals);
  return node === undefined ? "legacy" : readCommandErrorsContract(node);
};

/** Whether failures render as the JSON document: a machine `-o` or `--output-format`, or stdout that is not a TTY. */
export const isMachineFailureMode = (
  args: ReadonlyArray<string>,
  stdoutIsTty: boolean,
): boolean => {
  const outputFormat = readLongFlag(args, "--output-format");
  return (
    !stdoutIsTty ||
    outputFormat === "json" ||
    outputFormat === "stream-json" ||
    isMachineResourceFormat(Option.fromNullishOr(readOutputFlag(args)))
  );
};

/** Renders the failure as the stderr text: a leading blank line plus JSON, or a human message and hint. */
const renderStandardFailure = (pending: PendingStandardFailure): string => {
  if (pending.machine) return `\n${JSON.stringify(pending.document)}\n`;
  const { message, hint } = pending.document;
  return `${styleText("red", message)}\n${hint === null ? "" : `${hint}\n`}`;
};

/** Writes the pending failure to stderr; a closed or failing stderr never changes the exit code. */
export const writeStandardFailure = Effect.fn("StandardErrors.write")(function* (
  pending: PendingStandardFailure,
) {
  const stdio = yield* Stdio.Stdio;
  yield* writeStdio(stdio, "stderr", renderStandardFailure(pending)).pipe(Effect.ignore);
  yield* Effect.annotateCurrentSpan("standard_error.code", pending.document.code);
});
