import { markSupabaseApiInputErrorAsUserInput, SupabaseApiInputError } from "@supabase/api/effect";
import { Effect, Schema } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { CLI_UPGRADE_GUIDE_URL } from "../cli/version.ts";
import { WorkersApiNetworkError, WorkersApiUnexpectedStatusError } from "./workers.errors.ts";

/**
 * Status handling shared by every Workers API seam.
 *
 * The worker routes and the analytics logs endpoint sit on different API
 * families but fail the same three ways — the request never left, the server
 * answered something unexpected, or the body could not be read.
 *
 * Route-specific status meaning stays with its route rather than here.
 * `projectScoped404` is the example: it disambiguates a `/v2/workers` 404 by
 * response body and means nothing anywhere else.
 */

/**
 * Everything that can go wrong before a status code exists: the generated input
 * schema rejecting the request, or the transport failing outright.
 */
export function mapRequestError(operation: string) {
  return (error: unknown) => {
    if (error instanceof SupabaseApiInputError) {
      // The only inputs these operations take are the resolved project ref and
      // the prevalidated worker name, so a schema rejection is user-derived.
      return markSupabaseApiInputErrorAsUserInput(error);
    }
    if (HttpClientError.isHttpClientError(error)) {
      // `message` is the library's own rendering of the reason — its label, the
      // description when there is one, and the method and URL that failed.
      // These requests all go to the Management API, so that URL is safe to
      // show and is the most useful thing in the sentence.
      return new WorkersApiNetworkError({
        detail: `Could not reach the Workers API while trying to ${operation}: ${error.message}.`,
        suggestion: "Check your network connection and retry.",
      });
    }
    return new WorkersApiNetworkError({
      detail: `Could not reach the Workers API while trying to ${operation}: ${String(error)}.`,
      suggestion: "Check your network connection and retry.",
    });
  };
}

export const unexpectedStatus = Effect.fnUntraced(function* (options: {
  readonly operation: string;
  readonly status: number;
  readonly body: string;
}) {
  const trimmed = options.body.trim();
  return yield* Effect.fail(
    new WorkersApiUnexpectedStatusError({
      status: options.status,
      detail: `The Workers API answered ${options.status} while trying to ${options.operation}${
        trimmed === "" ? "" : `: ${trimmed}`
      }.`,
      suggestion: "Retry shortly; if it persists, report it with `supabase issue`.",
    }),
  );
});

export const decodeBody = <A, I>(
  schema: Schema.Codec<A, I>,
  operation: string,
  body: unknown,
  status: number,
) =>
  Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (error) =>
        new WorkersApiUnexpectedStatusError({
          status,
          detail: `The Workers API returned a response this CLI could not read while trying to ${operation}: ${error.message}.`,
          suggestion: `Update the CLI, then retry: ${CLI_UPGRADE_GUIDE_URL}`,
        }),
    ),
  );
