import { Effect } from "effect";

import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  DbAdvisorsPerformanceNetworkError,
  DbAdvisorsPerformanceStatusError,
  DbAdvisorsSecurityNetworkError,
  DbAdvisorsSecurityStatusError,
} from "./advisors.errors.ts";
import { apiLintsToAdvisorLints } from "./advisors.format.ts";

const mapSecurityError = mapHttpError({
  networkError: DbAdvisorsSecurityNetworkError,
  statusError: DbAdvisorsSecurityStatusError,
  networkMessage: (cause) => `failed to fetch security advisors: ${cause}`,
  statusMessage: (status, body) => `unexpected security advisors status ${status}: ${body}`,
});

const mapPerformanceError = mapHttpError({
  networkError: DbAdvisorsPerformanceNetworkError,
  statusError: DbAdvisorsPerformanceStatusError,
  networkMessage: (cause) => `failed to fetch performance advisors: ${cause}`,
  statusMessage: (status, body) => `unexpected performance advisors status ${status}: ${body}`,
});

export const fetchSecurityAdvisors = Effect.fn("db.advisors.fetchSecurity")(function* (
  ref: string,
) {
  const api = yield* (yield* CommandPlatformApiFactory).make;
  const output = yield* api.v1.getSecurityAdvisors({ ref }).pipe(Effect.catch(mapSecurityError));
  const lints = apiLintsToAdvisorLints(output.lints);
  yield* Effect.annotateCurrentSpan("advisor.count", lints.length);
  return lints;
});

export const fetchPerformanceAdvisors = Effect.fn("db.advisors.fetchPerformance")(function* (
  ref: string,
) {
  const api = yield* (yield* CommandPlatformApiFactory).make;
  const output = yield* api.v1
    .getPerformanceAdvisors({ ref })
    .pipe(Effect.catch(mapPerformanceError));
  const lints = apiLintsToAdvisorLints(output.lints);
  yield* Effect.annotateCurrentSpan("advisor.count", lints.length);
  return lints;
});
