import { styleText } from "node:util";

import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, type Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { resolveLegacyAccessToken } from "./legacy-resolve-token.ts";
import { parsePlanGateEnvelope, planGateSuggestion } from "../../shared/api/plan-gate.ts";
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

export function legacyGateResponse(
  cause: unknown,
): HttpClientResponse.HttpClientResponse | undefined {
  return HttpClientError.isHttpClientError(cause) ? cause.response : undefined;
}

export const legacyGateMapError =
  <E, R2>(
    opts: { readonly projectRef: string; readonly featureKey?: string },
    mapError: (cause: SupabaseApiError, upgradeSuggested: boolean) => Effect.Effect<never, E, R2>,
  ) =>
  (cause: SupabaseApiError) =>
    Effect.gen(function* () {
      const response = legacyGateResponse(cause);
      const upgradeSuggested = yield* legacySuggestUpgrade({
        projectRef: opts.projectRef,
        featureKey: opts.featureKey,
        statusCode: response?.status ?? 0,
        response,
      });
      return yield* mapError(cause, upgradeSuggested);
    });

/**
 * Entitlements-lookup fallback for envelope-less plan-gate denials (older
 * servers, ungated routes like v1 SSO). Envelope-carrying denials are handled
 * centrally in `mapLegacyHttpError` (hint, telemetry, and error fields), so
 * this stops after confirming the gate when the response body parses as an
 * `entitlement_required` envelope. Ports Go's
 * `plan_gate.go:SuggestUpgradeOnError`. Never fails the caller.
 *
 * The fallback bypasses the typed API client: its strict response schemas
 * reject the cli-e2e replay fixtures' placeholder refs (same workaround as
 * `legacy-linked-project-cache.layer.ts`).
 * Returns whether the feature was confirmed plan-gated so callers can carry
 * that typed result into their error classification.
 */
export const legacySuggestUpgrade = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
  /**
   * Entitlements-fallback key. Without it the fallback no-ops: a lookup
   * without a known key would false-positive on unrelated 4xxs.
   */
  readonly featureKey?: string;
  readonly statusCode: number;
  readonly response?: HttpClientResponse.HttpClientResponse;
  /**
   * Overrides the API base URL of the fallback project + entitlement GETs.
   * `SuggestUpgradeOnError` calls `GetSupabase()`, which targets the
   * process-wide `CurrentProfile` — commands that reconcile a pflag-effective
   * profile differing from the config layer's (sso add/update, PR #5974
   * round 7) pass that profile's URL so the gate requests hit the same host
   * as their main calls. Defaults to `LegacyCliConfig.apiUrl`.
   */
  readonly apiUrl?: string;
  /**
   * Overrides the bearer token of the fallback GETs, complementing `apiUrl`:
   * Go resolves credentials for the process-wide reconciled `CurrentProfile`,
   * so callers that pass a reconciled `apiUrl` must
   * pass the reconciled profile's token too — otherwise the stale profile's
   * bearer token would be sent to the reconciled host (review r3684524241).
   * `Some` uses that token, `None` sends unauthenticated (the reconciled
   * profile has no token — matching Go, which fails its token lookup and
   * never attaches the stale one), `undefined` resolves from the service.
   */
  readonly accessToken?: Option.Option<Redacted.Redacted<string>>;
  /**
   * Set false where the Go twin fires no `TrackUpgradeSuggested` (vanity
   * check-availability), keeping telemetry 1:1 on the fallback path. The
   * central handler's equivalent switch is `trackUpgradeSuggested` on its
   * `mapLegacyHttpError` options.
   */
  readonly trackAnalytics?: boolean;
}) {
  if (opts.statusCode < 400 || opts.statusCode >= 500) {
    return false;
  }

  const output = yield* Output;
  const analytics = yield* Analytics;
  const cliConfig = yield* LegacyCliConfig;
  const httpClient = yield* HttpClient.HttpClient;

  if (opts.response !== undefined) {
    const body = yield* opts.response.json.pipe(Effect.option);
    const envelope = Option.isSome(body) ? parsePlanGateEnvelope(body.value) : undefined;
    if (envelope !== undefined) {
      // Confirmed gated, but the central handler already attached the error
      // fields, printed the hint, and fired the telemetry for this denial.
      return true;
    }
  }

  if (opts.featureKey === undefined || opts.featureKey === "") {
    return false;
  }

  const tokenOpt = opts.accessToken ?? (yield* resolveLegacyAccessToken);
  const authHeader: (
    req: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest = Option.isSome(tokenOpt)
    ? HttpClientRequest.bearerToken(tokenOpt.value)
    : (req) => req;

  const apiUrl = opts.apiUrl ?? cliConfig.apiUrl;
  const projectReq = HttpClientRequest.get(`${apiUrl}/v1/projects/${opts.projectRef}`).pipe(
    authHeader,
    HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
  );
  const projectResp = yield* httpClient.execute(projectReq).pipe(Effect.option);
  if (projectResp._tag === "None" || projectResp.value.status !== 200) {
    return false;
  }
  const projectBody = yield* projectResp.value.json.pipe(Effect.option);
  if (projectBody._tag === "None") {
    return false;
  }
  const orgSlug = readString(projectBody.value, "organization_slug");
  if (orgSlug.length === 0) {
    return false;
  }

  const entReq = HttpClientRequest.get(`${apiUrl}/v1/organizations/${orgSlug}/entitlements`).pipe(
    authHeader,
    HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
  );
  const entResp = yield* httpClient.execute(entReq).pipe(Effect.option);
  if (entResp._tag === "None" || entResp.value.status !== 200) {
    return false;
  }
  const entBody = yield* entResp.value.json.pipe(Effect.option);
  if (entBody._tag === "None") {
    return false;
  }
  const entitlements = (entBody.value as { entitlements?: unknown }).entitlements;
  if (!Array.isArray(entitlements)) {
    return false;
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
    return false;
  }

  const billingUrl = legacyBillingUrl(cliConfig.profile, orgSlug);
  const suggestion = planGateSuggestion(styleText("bold", billingUrl));

  if (output.format === "text") {
    yield* output.raw(suggestion + "\n", "stderr");
  }

  if (opts.trackAnalytics !== false) {
    yield* analytics.capture(EventUpgradeSuggested, {
      [PropFeatureKey]: opts.featureKey,
      [PropOrgSlug]: orgSlug,
    });
  }

  return true;
});
