import { markSupabaseApiInputErrorAsUserInput, SupabaseApiInputError } from "@supabase/api/effect";
import { Effect, Option, Schema } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { CLI_UPGRADE_GUIDE_URL } from "../cli/version.ts";
import {
  ComputeApiNetworkError,
  ComputeApiUnexpectedStatusError,
  ComputeProjectNotFoundError,
} from "./compute.errors.ts";

/**
 * Status handling shared by every Compute API seam: the compute routes and the analytics logs
 * endpoint fail the same three ways (the request never left, the server answered something
 * unexpected, or the body couldn't be read), and both have to tell several 404s apart by body.
 * Reading a 404 body is shared here; what each code *means* on a given route — like
 * `projectScoped404` — stays with that route.
 */

/**
 * Everything that can go wrong before a status code exists: the generated input
 * schema rejecting the request, or the transport failing outright.
 */
export function mapRequestError(operation: string) {
  return (error: unknown) => {
    if (error instanceof SupabaseApiInputError) {
      // The only inputs these operations take are the resolved project ref and
      // the prevalidated compute name, so a schema rejection is user-derived.
      return markSupabaseApiInputErrorAsUserInput(error);
    }
    if (HttpClientError.isHttpClientError(error)) {
      // `message` is the library's own rendering of the reason — its label, the
      // description when there is one, and the method and URL that failed.
      // These requests all go to the Management API, so that URL is safe to
      // show and is the most useful thing in the sentence.
      return new ComputeApiNetworkError({
        detail: `Could not reach the Compute API while trying to ${operation}: ${error.message}.`,
        suggestion: "Check your network connection and retry.",
      });
    }
    return new ComputeApiNetworkError({
      detail: `Could not reach the Compute API while trying to ${operation}: ${String(error)}.`,
      suggestion: "Check your network connection and retry.",
    });
  };
}

/**
 * The response body as text, empty when it cannot be read. Every caller wants it for an error
 * message, where a failed read is not worth a second failure of its own.
 */
export const bodyText = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(Effect.orElseSucceed(() => ""));

/** Fails with the status the response carries, quoting whatever body came with it. */
export const unexpectedStatus = Effect.fnUntraced(function* (
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
) {
  const trimmed = (yield* bodyText(response)).trim();
  return yield* new ComputeApiUnexpectedStatusError({
    status: response.status,
    detail: `The Compute API answered ${response.status} while trying to ${operation}${
      trimmed === "" ? "" : `: ${trimmed}`
    }.`,
    suggestion: "Retry shortly; if it persists, report it with `supabase issue`.",
  });
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
        new ComputeApiUnexpectedStatusError({
          status,
          detail: `The Compute API returned a response this CLI could not read while trying to ${operation}: ${error.message}.`,
          suggestion: `Update the CLI, then retry: ${CLI_UPGRADE_GUIDE_URL}`,
        }),
    ),
  );

/** The response's JSON body decoded against `schema`, the shape every 2xx read here needs. */
export const decodeJsonBody = <A, I>(
  schema: Schema.Codec<A, I>,
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.json.pipe(
    Effect.mapError(mapRequestError(operation)),
    Effect.flatMap((body) => decodeBody(schema, operation, body, response.status)),
  );

/**
 * The Management API's error envelope, as it arrives on a 404.
 *
 * `message` is `Unknown` rather than `String` so a non-string message cannot fail the decode and
 * cost the code-based classification that follows it.
 */
const NotFoundBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.optionalKey(Schema.Unknown),
  }),
});

type NotFoundEnvelope = Schema.Schema.Type<typeof NotFoundBody>;

/** The 404 body parsed into its envelope, or `None` when it is something else entirely. */
export const parse404 = (body: string) =>
  Schema.decodeEffect(Schema.fromJsonString(NotFoundBody))(body).pipe(Effect.option);

/** Express's default for an unrouted path. Anchored so a message merely containing it cannot match. */
const ROUTE_NOT_FOUND_MESSAGE = /^Cannot [A-Z]+ \//;

/** The route named by the router's own 404 text, when the body is that rather than a handler's. */
export const unroutedPath = (parsed: Option.Option<NotFoundEnvelope>): Option.Option<string> => {
  if (Option.isNone(parsed)) return Option.none();
  const { message } = parsed.value.error;
  // `Cannot GET /v2/projects/{ref}/compute` -> `GET /v2/projects/{ref}/compute`
  return typeof message === "string" && ROUTE_NOT_FOUND_MESSAGE.test(message)
    ? Option.some(message.slice("Cannot ".length))
    : Option.none();
};

export const hasErrorCode = (parsed: Option.Option<NotFoundEnvelope>, code: string) =>
  Option.isSome(parsed) && parsed.value.error.code === code;

/** The ref names no project this account can see — the same verdict on every seam that reads one. */
export const projectNotFound = (projectRef: string) =>
  new ComputeProjectNotFoundError({
    detail: `No project ${projectRef} was found for this account.`,
    suggestion:
      "Check the project ref, or pick the project again with `supabase link`. " +
      "If it belongs to another account, log in with `supabase login`.",
  });
