import { Duration, Effect, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { RealtimeEndpointFailureKind } from "./realtime.errors.ts";

export type RealtimeProbeOutcome =
  | {
      readonly kind: "reachable";
      readonly status: number;
      readonly detail: string;
    }
  | {
      readonly kind: RealtimeEndpointFailureKind;
      readonly status: number | undefined;
      readonly detail: string;
    };

const PROBE_TIMEOUT = Duration.seconds(10);

export const probeRealtimeEndpoint = Effect.fnUntraced(function* (opts: {
  readonly url: string;
  readonly apiKey: Redacted.Redacted<string>;
}) {
  const endpoint = `${opts.url.replace(/\/+$/, "")}/realtime/v1/websocket`;
  const host = realtimeHostLabel(endpoint);
  const client = yield* HttpClient.HttpClient;

  const request = HttpClientRequest.get(endpoint).pipe(
    HttpClientRequest.setUrlParam("apikey", Redacted.value(opts.apiKey)),
  );

  return yield* client.execute(request).pipe(
    Effect.map((response): RealtimeProbeOutcome => {
      if (response.status === 404) {
        return {
          kind: "not_found",
          status: 404,
          detail: `No Realtime server at ${host}. Check the project ref or the URL.`,
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          kind: "unauthorized",
          status: response.status,
          detail: `${host} rejected the API key.`,
        };
      }
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        return {
          kind: "server_error",
          status: response.status,
          detail: `${host} answered ${response.status}; Realtime is not reachable through its gateway.`,
        };
      }
      return {
        kind: "reachable",
        status: response.status,
        detail: `${host} is serving Realtime (probe status ${response.status}).`,
      };
    }),
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT,
      orElse: () =>
        Effect.succeed<RealtimeProbeOutcome>({
          kind: "unreachable",
          status: undefined,
          detail: `${host} did not answer within ${Duration.toSeconds(PROBE_TIMEOUT)}s.`,
        }),
    }),
    Effect.catch(() =>
      Effect.succeed<RealtimeProbeOutcome>({
        kind: "unreachable",
        status: undefined,
        detail: `Could not reach ${host}. Check the URL, your network, or whether the server is running.`,
      }),
    ),
  );
});

function realtimeHostLabel(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
