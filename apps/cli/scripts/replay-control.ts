/**
 * Client for the replay server's `/_ctrl/*` HTTP API, used by `bench-cli.ts` to start each launch
 * from a known server state. Any failed control call aborts the benchmark, because a launch that
 * runs against stale or missing scenario state measures the wrong work.
 */
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export class ReplayControlError extends Schema.TaggedError<ReplayControlError>()(
  "ReplayControlError",
  { step: Schema.String, message: Schema.String },
) {}

export interface ControlCall {
  readonly method: "DELETE" | "POST";
  readonly path: string;
  readonly body?: { readonly name: string };
}

/** The calls that clear the request log and select `scenario`, or no scenario when it is absent. */
export function controlPlan(scenario: string | undefined): ReadonlyArray<ControlCall> {
  return [
    { method: "DELETE", path: "/_ctrl/requests" },
    { method: "DELETE", path: "/_ctrl/scenario" },
    ...(scenario === undefined
      ? []
      : [{ method: "POST", path: "/_ctrl/scenario", body: { name: scenario } } as const]),
  ];
}

const controlUrl = (apiUrl: string, path: string) => new URL(path, apiUrl).toString();

const failure = (step: string) => (cause: unknown) =>
  new ReplayControlError({
    step,
    message: `${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const send = Effect.fn("ReplayControl.send")(function* (
  apiUrl: string,
  method: "GET" | "DELETE" | "POST",
  path: string,
  body?: { readonly name: string },
) {
  const step = `${method} ${path}`;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const base =
    method === "GET"
      ? HttpClientRequest.get(controlUrl(apiUrl, path))
      : method === "DELETE"
        ? HttpClientRequest.delete(controlUrl(apiUrl, path))
        : HttpClientRequest.post(controlUrl(apiUrl, path));
  const request = body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body);
  return yield* client.execute(request).pipe(Effect.mapError(failure(step)));
});

/** Resets the request log and scenario so the next launch sees a freshly loaded scenario. */
export const resetReplay = Effect.fn("ReplayControl.reset")(function* (
  apiUrl: string,
  scenario: string | undefined,
) {
  for (const call of controlPlan(scenario)) {
    yield* send(apiUrl, call.method, call.path, call.body);
  }
});

const RequestLog = Schema.Array(Schema.Struct({ method: Schema.String, pathname: Schema.String }));

/** Number of API requests the server has logged since the last reset. */
export const readRequestLogCount = Effect.fn("ReplayControl.readRequestLogCount")(function* (
  apiUrl: string,
) {
  const response = yield* send(apiUrl, "GET", "/_ctrl/requests");
  const json = yield* HttpClientResponse.schemaBodyJson(RequestLog)(response).pipe(
    Effect.mapError(failure("GET /_ctrl/requests body")),
  );
  return json.length;
});
