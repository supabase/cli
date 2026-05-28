import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCredentials } from "../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { resolveLegacyAccessToken } from "../shared/legacy-resolve-token.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import {
  EventUpgradeSuggested,
  PropFeatureKey,
  PropOrgSlug,
} from "../../shared/telemetry/event-catalog.ts";

function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

/**
 * Mirrors Go's `utils.SuggestUpgradeOnError` + `telemetry.TrackUpgradeSuggested`
 * (`apps/cli-go/internal/utils/plan_gate.go:28-53`,
 * `apps/cli-go/internal/telemetry/events.go:56-63`).
 *
 *  - Only runs for 4xx (`>= 400 && < 500`). 2xx and 5xx are no-ops.
 *  - GETs the project to resolve `organization_slug`. Transport / non-200
 *    failures are swallowed silently (matches Go's two-level early-return).
 *  - GETs organization entitlements; scans for the requested feature key
 *    with `hasAccess === false`.
 *  - On a positive gate match, fires `cli_upgrade_suggested` with the
 *    feature key and org slug.
 *  - Every failure mode is swallowed: this is best-effort telemetry that
 *    must never derail the command's primary error reporting. The return
 *    type's error channel is `never`.
 *
 * Bypasses `LegacyPlatformApi`'s typed schema decode by calling the
 * Management API directly with `HttpClient`. The generated
 * `V1GetProjectOutput` schema enforces a 20-char `ref` length that the
 * cli-e2e replay fixtures (which store `__PROJECT_REF__` placeholders in
 * response bodies) cannot satisfy — same workaround used by
 * `legacy-linked-project-cache.layer.ts`. Go's generated client doesn't
 * apply the same length check on response decode.
 *
 * Hoisted to `legacy/telemetry/` (not the sso command directory) because
 * the branches/{create,update} ports will reuse it.
 */
export const suggestUpgradeOnError = (
  projectRef: string,
  featureKey: string,
  statusCode: number,
): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | LegacyCliConfig | LegacyCredentials | Analytics
> =>
  Effect.gen(function* () {
    if (statusCode < 400 || statusCode >= 500) return;

    const analytics = yield* Analytics;
    const httpClient = yield* HttpClient.HttpClient;
    const cliConfig = yield* LegacyCliConfig;
    const tokenOpt = yield* resolveLegacyAccessToken;
    const authHeader: (
      req: HttpClientRequest.HttpClientRequest,
    ) => HttpClientRequest.HttpClientRequest = Option.isSome(tokenOpt)
      ? HttpClientRequest.bearerToken(tokenOpt.value)
      : (req) => req;

    const projectRequest = HttpClientRequest.get(
      `${cliConfig.apiUrl}/v1/projects/${projectRef}`,
    ).pipe(authHeader, HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent));
    const projectResponse = yield* httpClient.execute(projectRequest);
    if (projectResponse.status !== 200) return;
    const projectBody = yield* projectResponse.json;
    const orgSlug = readString(projectBody, "organization_slug");
    if (orgSlug.length === 0) return;

    const entRequest = HttpClientRequest.get(
      `${cliConfig.apiUrl}/v1/organizations/${orgSlug}/entitlements`,
    ).pipe(authHeader, HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent));
    const entResponse = yield* httpClient.execute(entRequest);
    if (entResponse.status !== 200) return;
    const entBody = yield* entResponse.json;
    const entitlements = (entBody as { entitlements?: unknown })?.entitlements;
    if (!Array.isArray(entitlements)) return;

    const gated = entitlements.some((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const feature = (entry as { feature?: unknown }).feature;
      if (typeof feature !== "object" || feature === null) return false;
      const key = (feature as { key?: unknown }).key;
      const hasAccess = (entry as { hasAccess?: unknown }).hasAccess;
      return key === featureKey && hasAccess === false;
    });
    if (!gated) return;

    yield* analytics.capture(EventUpgradeSuggested, {
      [PropFeatureKey]: featureKey,
      [PropOrgSlug]: orgSlug,
    });
  }).pipe(Effect.catch(() => Effect.void));
