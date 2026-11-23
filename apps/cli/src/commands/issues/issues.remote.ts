import type { ApiClient } from "@supabase/api/effect";
import { Effect } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import {
  fetchPerformanceAdvisors,
  fetchSecurityAdvisors,
} from "../../command-internal/advisors/advisors.linked.ts";
import {
  DbAdvisorsPerformanceNetworkError,
  DbAdvisorsPerformanceStatusError,
  DbAdvisorsSecurityNetworkError,
  DbAdvisorsSecurityStatusError,
} from "../../command-internal/advisors/advisors.errors.ts";
import { IssuesHealthAuthorizationError } from "./issues.errors.ts";
import { AUTHENTICATION_FAILED_STATUS_MESSAGE } from "../../command-internal/http-errors.ts";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import {
  apiLintsToAdvisorLints,
  type AdvisorLint,
} from "../../command-internal/advisors/advisors.format.ts";
import { issueCheckCoverage, type CheckCoverage, type IssueCategory } from "./issues.format.ts";

const healthChecks = [
  "log_data_api_error_rate_high",
  "log_auth_error_rate_high",
  "log_storage_error_rate_high",
  "log_edge_function_error_rate_high",
] as const;

const responseStatus = (error: unknown): number | undefined => {
  if (
    error instanceof DbAdvisorsSecurityStatusError ||
    error instanceof DbAdvisorsPerformanceStatusError
  )
    return error.status;
  return HttpClientError.isHttpClientError(error) ? error.response?.status : undefined;
};

const unavailableReason = (error: unknown): string => {
  const status = responseStatus(error);
  if (status !== undefined && (status < 200 || status >= 300))
    return `The Management API returned HTTP ${status}. Retry this check later.`;
  if (
    (HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError") ||
    ((error instanceof DbAdvisorsSecurityNetworkError ||
      error instanceof DbAdvisorsPerformanceNetworkError) &&
      error.decode !== true)
  )
    return "Could not reach the Management API. Check your connection and retry.";
  return "The Management API request or response could not be processed. Retry this check later.";
};

const fetchRemoteIssues = Effect.fn("issues.fetchRemote")(function* (
  api: ApiClient,
  ref: string,
  category: IssueCategory,
) {
  if (category === "security") return yield* fetchSecurityAdvisors(ref, api);
  if (category === "performance") return yield* fetchPerformanceAdvisors(ref, api);
  const result = yield* api.v2.runProjectAdvisors({
    ref,
    data: {
      type: "project_advisors",
      attributes: { lints: healthChecks.map((name) => ({ name })) },
    },
  });
  return apiLintsToAdvisorLints(result.data.attributes.lints);
});

export const collectRemoteIssues = Effect.fn("issues.collectRemote")(function* (
  ref: string,
  categories: ReadonlyArray<IssueCategory>,
) {
  const api = yield* (yield* CommandPlatformApiFactory).make;
  const results = yield* Effect.forEach(
    categories,
    (category) =>
      fetchRemoteIssues(api, ref, category).pipe(
        Effect.map((found) => {
          const check = issueCheckCoverage(category, found);
          const lints: ReadonlyArray<AdvisorLint> = found.map((lint) => ({
            ...lint,
            categories: [category.toUpperCase()],
          }));
          return { check, lints };
        }),
        Effect.catch((error) => {
          const status = responseStatus(error);
          if (status === 401 || status === 403)
            return Effect.fail(
              category === "health"
                ? new IssuesHealthAuthorizationError({
                    status,
                    message:
                      status === 401
                        ? AUTHENTICATION_FAILED_STATUS_MESSAGE
                        : "Access denied: your access token does not have permission to run health checks. Check your project permissions or use a token with the required access.",
                  })
                : error,
            );
          const check: CheckCoverage = {
            type: category,
            status: "unavailable",
            reason: unavailableReason(error),
          };
          return Effect.succeed({ check, lints: [] });
        }),
      ),
    { concurrency: "unbounded" },
  );
  const checks = results.map((result) => result.check);
  yield* Effect.annotateCurrentSpan(
    "issues.unavailable_count",
    checks.filter((check) => check.status === "unavailable").length,
  );
  return { checks, lints: results.flatMap((result) => result.lints) };
});
