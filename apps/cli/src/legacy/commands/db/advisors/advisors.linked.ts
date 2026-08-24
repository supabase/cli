import { Effect, Schema } from "effect";
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
  /**
   * Builds the network/parse failure (`failed to fetch … advisors: %w`).
   * `decode: true` marks a 200-response body decode failure rather than a
   * transport failure, even though both fold into the same message path.
   */
  readonly network: (
    message: string,
    opts?: { readonly decode?: boolean },
  ) => LegacyAdvisorNetworkError;
  /** Builds the non-200 failure (`unexpected … advisors status %d: %s`). */
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

/** Identity stitcher: every Management API response is wrapped in identity
 *  stitching; the raw-HTTP advisor path runs it explicitly. */
type LegacyStitchFn = (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<void>;

/**
 * Shared GET for an advisors endpoint. Uses raw HTTP + a tolerant parse rather
 * than the typed client, since the generated schema's closed `name` /
 * `metadata.type` literals would reject advisor names / metadata types the
 * API can add.
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

  // Stitch the session identity from the X-Gotrue-Id header, run on every
  // Management API response.
  yield* stitch(response);

  if (response.status !== 200) {
    const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* endpoint.status(response.status, sanitizeLegacyErrorBody(rawBody));
  }

  // The 200 body is only decoded when the Content-Type header contains "json";
  // otherwise the fetcher returns the status-200 error. Match that so a header
  // regression returning JSON text isn't accepted as a valid advisor result.
  const contentType = response.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* endpoint.status(200, sanitizeLegacyErrorBody(rawBody));
  }

  const rawBody = yield* response.text;
  // A decode error folds into the same `failed to fetch … advisors: %w` path,
  // so map both JSON syntax errors and structural-shape rejections (thrown by
  // `apiResponseToLegacyAdvisorLints`) to the endpoint's network error.
  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(rawBody).pipe(
    Effect.mapError((cause) => endpoint.network(String(cause), { decode: true })),
  );
  return yield* Effect.try({
    try: () => apiResponseToLegacyAdvisorLints(decoded),
    catch: (cause) => endpoint.network(String(cause), { decode: true }),
  });
});

export const legacyFetchSecurityAdvisors = (ref: string, stitch: LegacyStitchFn) =>
  fetchAdvisors(
    ref,
    {
      path: "security",
      network: (message, opts) =>
        new LegacyDbAdvisorsSecurityNetworkError({
          message: `failed to fetch security advisors: ${message}`,
          decode: opts?.decode,
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
      network: (message, opts) =>
        new LegacyDbAdvisorsPerformanceNetworkError({
          message: `failed to fetch performance advisors: ${message}`,
          decode: opts?.decode,
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
