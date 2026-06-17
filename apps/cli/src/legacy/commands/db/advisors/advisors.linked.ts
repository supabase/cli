import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

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

/** Identity stitcher: Go wraps every Management API response in identityTransport
 *  (`OnGotrueID` → `StitchLogin`); the raw-HTTP advisor path runs it explicitly. */
type LegacyStitchFn = (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<void>;

/**
 * Shared GET for an advisors endpoint. Uses raw HTTP + a tolerant parse rather
 * than the typed client, mirroring Go's permissive `type X string` structs (the
 * TS generated schema's closed `name` / `metadata.type` literals would reject
 * values the API can add). Models Go's `fetchSecurityAdvisors` /
 * `fetchPerformanceAdvisors` (`advisors.go:162-182`).
 */
const fetchAdvisors = Effect.fnUntraced(function* (
  ref: string,
  endpoint: AdvisorEndpoint,
  stitch: LegacyStitchFn,
) {
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

  // Stitch the session identity from the X-Gotrue-Id header, matching Go's
  // identityTransport which runs on every Management API response (`api.go:128`).
  yield* stitch(response);

  if (response.status !== 200) {
    const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* Effect.fail(endpoint.status(response.status, sanitizeLegacyErrorBody(rawBody)));
  }

  // Go's generated parser only decodes the 200 body when the Content-Type header
  // contains "json" (`pkg/api/client.gen.go` `strings.Contains(..., "json")`);
  // otherwise `JSON200` stays nil and the fetcher returns the status-200 error
  // (`internal/db/advisors/advisors.go:167-169,178-180`). Match that so a header
  // regression returning JSON text isn't accepted as a valid advisor result.
  const contentType = response.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* Effect.fail(endpoint.status(200, sanitizeLegacyErrorBody(rawBody)));
  }

  const rawBody = yield* response.text;
  // Go folds a decode error into the same `failed to fetch … advisors: %w` path,
  // so map both JSON syntax errors and structural-shape rejections (thrown by
  // `apiResponseToLegacyAdvisorLints`) to the endpoint's network error.
  return yield* Effect.try({
    try: () => apiResponseToLegacyAdvisorLints(JSON.parse(rawBody) as unknown),
    catch: (cause) => endpoint.network(String(cause)),
  });
});

export const legacyFetchSecurityAdvisors = (ref: string, stitch: LegacyStitchFn) =>
  fetchAdvisors(
    ref,
    {
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
    },
    stitch,
  );

export const legacyFetchPerformanceAdvisors = (ref: string, stitch: LegacyStitchFn) =>
  fetchAdvisors(
    ref,
    {
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
    },
    stitch,
  );
