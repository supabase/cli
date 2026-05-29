import { styleText } from "node:util";

import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { resolveLegacyAccessToken } from "./legacy-resolve-token.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import {
  EventUpgradeSuggested,
  PropFeatureKey,
  PropOrgSlug,
} from "../../shared/telemetry/event-catalog.ts";
import { Output } from "../../shared/output/output.service.ts";
import { legacyBillingUrl } from "./legacy-profile.ts";

function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

/**
 * Reproduces `apps/cli-go/internal/utils/plan_gate.go:SuggestUpgradeOnError`:
 *
 *   - Skip non-4xx statuses (2xx / 5xx).
 *   - GET `/v1/projects/{ref}` → `organization_slug`.
 *   - GET `/v1/organizations/{slug}/entitlements` → look for the requested feature
 *     key with `hasAccess: false`.
 *   - On gated: write the billing-link suggestion to stderr (text mode only,
 *     matches Go's `CmdSuggestion` print) **and** fire the `cli_upgrade_suggested`
 *     telemetry event with `{feature_key, org_slug}` properties.
 *
 * Never fails the caller; lookup errors swallow into a no-op suggestion.
 *
 * Bypasses the typed Management API client to GET `/v1/projects/{ref}` and
 * `/v1/organizations/{slug}/entitlements` directly via `HttpClient`. The
 * generated `V1GetProjectOutput` schema enforces `ref: isMinLength(20)`, which
 * the cli-e2e replay fixtures cannot satisfy (they embed the literal 15-char
 * `__PROJECT_REF__` placeholder in response bodies). Strict decode would fail
 * silently inside `Effect.option`, the entitlements GET would be skipped, and
 * parity with Go's request log would break. Same workaround used by
 * `legacy-linked-project-cache.layer.ts`.
 */
export const legacySuggestUpgrade = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
  readonly featureKey: string;
  readonly statusCode: number;
  /**
   * Whether to fire the `cli_upgrade_suggested` analytics event when a gate is
   * detected. Defaults to `true`. Pass `false` for Go call-sites that invoke
   * `SuggestUpgradeOnError` without a following `TrackUpgradeSuggested`
   * (e.g. `vanity-subdomains check-availability`), so telemetry stays 1:1 with Go.
   */
  readonly trackAnalytics?: boolean;
}) {
  if (opts.statusCode < 400 || opts.statusCode >= 500) {
    return;
  }

  const output = yield* Output;
  const analytics = yield* Analytics;
  const cliConfig = yield* LegacyCliConfig;
  const httpClient = yield* HttpClient.HttpClient;

  const tokenOpt = yield* resolveLegacyAccessToken;
  const authHeader: (
    req: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest = Option.isSome(tokenOpt)
    ? HttpClientRequest.bearerToken(tokenOpt.value)
    : (req) => req;

  const projectReq = HttpClientRequest.get(
    `${cliConfig.apiUrl}/v1/projects/${opts.projectRef}`,
  ).pipe(authHeader, HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent));
  const projectResp = yield* httpClient.execute(projectReq).pipe(Effect.option);
  if (projectResp._tag === "None" || projectResp.value.status !== 200) {
    return;
  }
  const projectBody = yield* projectResp.value.json.pipe(Effect.option);
  if (projectBody._tag === "None") {
    return;
  }
  const orgSlug = readString(projectBody.value, "organization_slug");
  if (orgSlug.length === 0) {
    return;
  }

  const entReq = HttpClientRequest.get(
    `${cliConfig.apiUrl}/v1/organizations/${orgSlug}/entitlements`,
  ).pipe(authHeader, HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent));
  const entResp = yield* httpClient.execute(entReq).pipe(Effect.option);
  if (entResp._tag === "None" || entResp.value.status !== 200) {
    return;
  }
  const entBody = yield* entResp.value.json.pipe(Effect.option);
  if (entBody._tag === "None") {
    return;
  }
  const entitlements = (entBody.value as { entitlements?: unknown }).entitlements;
  if (!Array.isArray(entitlements)) {
    return;
  }

  const gated = entitlements.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const feature = (entry as { feature?: unknown }).feature;
    if (typeof feature !== "object" || feature === null) return false;
    const key = (feature as { key?: unknown }).key;
    const hasAccess = (entry as { hasAccess?: unknown }).hasAccess;
    return key === opts.featureKey && hasAccess === false;
  });
  if (!gated) {
    return;
  }

  const url = legacyBillingUrl(cliConfig.profile, orgSlug);
  const suggestion = `Your organization does not have access to this feature. Upgrade your plan: ${styleText("bold", url)}`;

  if (output.format === "text") {
    yield* output.raw(suggestion + "\n", "stderr");
  }

  if (opts.trackAnalytics !== false) {
    yield* analytics.capture(EventUpgradeSuggested, {
      [PropFeatureKey]: opts.featureKey,
      [PropOrgSlug]: orgSlug,
    });
  }
});
