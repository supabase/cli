import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { Output } from "../../shared/output/output.service.ts";

/** Bounds each SSO read attempt; a project whose auth service is down stalls the request. */
export const SSO_READ_REQUEST_OPTIONS = {
  retry: { requestTimeoutMs: 10_000 },
} as const;

// 4xx responses are SSO-specific (plan gate, missing provider); only transport failures and
// 5xx point at the project itself.
const mayBeProjectHealth = (cause: SupabaseApiError) =>
  cause._tag === "HttpClientError" &&
  (cause.response === undefined || cause.response.status >= 500);

/** Warns when an SSO call fails on a project that is not `ACTIVE_HEALTHY`, the usual cause. */
export const warnIfProjectUnhealthy = Effect.fn("sso.projectHealth")(function* (
  ref: string,
  cause: SupabaseApiError,
) {
  if (!mayBeProjectHealth(cause)) {
    return;
  }
  const api = yield* CommandPlatformApi;
  const output = yield* Output;
  const project = yield* api.v1
    .getProject({ ref }, { retry: { maxRetries: 0, requestTimeoutMs: 10_000 } })
    .pipe(Effect.option);
  if (Option.isNone(project)) {
    return;
  }
  const status = project.value.status;
  yield* Effect.annotateCurrentSpan("project.status", status);
  if (status !== "ACTIVE_HEALTHY") {
    yield* output.warn(
      `Project ${ref} status is ${status} instead of ACTIVE_HEALTHY. SSO providers can only be managed on an active, healthy project.`,
    );
  }
});
