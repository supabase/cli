import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { requestWithAuth } from "../../../shared/legacy-raw-http.ts";
import { resolveLegacyAccessToken } from "../../../shared/legacy-resolve-token.ts";
import {
  LegacyDbAdvisorsPerformanceNetworkError,
  LegacyDbAdvisorsPerformanceStatusError,
  LegacyDbAdvisorsSecurityNetworkError,
  LegacyDbAdvisorsSecurityStatusError,
} from "./advisors.errors.ts";
import { apiResponseToLegacyAdvisorLints } from "./advisors.format.ts";

interface AdvisorEndpoint {
  readonly path: "security" | "performance";
  /** Builds the network/parse failure (Go's `failed to fetch … advisors: %w`). */
  readonly network: (message: string) => LegacyAdvisorNetworkError;
  /** Builds the non-200 failure (Go's `unexpected … advisors status %d: %s`). */
  readonly status: (status: number, body: string) => LegacyAdvisorStatusError;
}

type LegacyAdvisorNetworkError =
  | LegacyDbAdvisorsSecurityNetworkError
  | LegacyDbAdvisorsPerformanceNetworkError;
type LegacyAdvisorStatusError =
  | LegacyDbAdvisorsSecurityStatusError
  | LegacyDbAdvisorsPerformanceStatusError;

const describeHttpError = (cause: unknown): string =>
  HttpClientError.isHttpClientError(cause)
    ? (cause.reason.description ?? cause.reason._tag)
    : String(cause);

/**
 * Shared GET for an advisors endpoint. Uses raw HTTP + a tolerant parse rather
 * than the typed client, mirroring Go's permissive `type X string` structs (the
 * TS generated schema's closed `name` / `metadata.type` literals would reject
 * values the API can add). Models Go's `fetchSecurityAdvisors` /
 * `fetchPerformanceAdvisors` (`advisors.go:162-182`).
 */
const fetchAdvisors = Effect.fnUntraced(function* (ref: string, endpoint: AdvisorEndpoint) {
  const httpClient = yield* HttpClient.HttpClient;
  const cliConfig = yield* LegacyCliConfig;
  const tokenOpt = yield* resolveLegacyAccessToken;

  const request = requestWithAuth(
    HttpClientRequest.get(`${cliConfig.apiUrl}/v1/projects/${ref}/advisors/${endpoint.path}`),
    tokenOpt,
    cliConfig.userAgent,
  );

  const response = yield* httpClient
    .execute(request)
    .pipe(Effect.mapError((cause) => endpoint.network(describeHttpError(cause))));

  if (response.status !== 200) {
    const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* Effect.fail(endpoint.status(response.status, sanitizeLegacyErrorBody(rawBody)));
  }

  const rawBody = yield* response.text;
  const parsed = yield* Effect.try({
    try: () => JSON.parse(rawBody) as unknown,
    catch: (cause) => endpoint.network(String(cause)),
  });
  return apiResponseToLegacyAdvisorLints(parsed);
});

export const legacyFetchSecurityAdvisors = (ref: string) =>
  fetchAdvisors(ref, {
    path: "security",
    network: (message) =>
      new LegacyDbAdvisorsSecurityNetworkError({
        message: `failed to fetch security advisors: ${message}`,
      }),
    status: (status, body) =>
      new LegacyDbAdvisorsSecurityStatusError({
        status,
        body,
        message: `unexpected security advisors status ${status}: ${body}`,
      }),
  });

export const legacyFetchPerformanceAdvisors = (ref: string) =>
  fetchAdvisors(ref, {
    path: "performance",
    network: (message) =>
      new LegacyDbAdvisorsPerformanceNetworkError({
        message: `failed to fetch performance advisors: ${message}`,
      }),
    status: (status, body) =>
      new LegacyDbAdvisorsPerformanceStatusError({
        status,
        body,
        message: `unexpected performance advisors status ${status}: ${body}`,
      }),
  });
