import { styleText } from "node:util";

import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

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

interface LegacyPlanGateEnvelope {
  readonly feature: string;
  readonly upgradeUrl: string;
}

/**
 * Parses the management API's plan-gate error body,
 * `{ message, error: { code: "entitlement_required", feature, upgrade_url } }`.
 * The `packages/api` codegen intentionally emits no non-2xx schemas, so this
 * shape is hand-validated here (the Go twin uses the generated
 * `api.PlanGateErrorBody`).
 */
function parseLegacyPlanGateEnvelope(body: unknown): LegacyPlanGateEnvelope | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { readonly error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const code = readString(error, "code");
  const feature = readString(error, "feature");
  const upgradeUrl = readString(error, "upgrade_url");
  if (code !== "entitlement_required" || feature === "" || upgradeUrl === "") {
    return undefined;
  }
  return { feature, upgradeUrl };
}

function legacyOrgSlugFromUpgradeUrl(upgradeUrl: string): string {
  const match = /\/org\/([^/]+)/.exec(upgradeUrl);
  return match?.[1] ?? "";
}

/**
 * Extracts the failed HttpClientResponse from a caught SupabaseApiError so
 * call sites can hand `legacySuggestUpgrade` the body without repeating the
 * isHttpClientError narrowing.
 */
export function legacyGateResponse(
  cause: unknown,
): HttpClientResponse.HttpClientResponse | undefined {
  return HttpClientError.isHttpClientError(cause) ? cause.response : undefined;
}

/**
 * Builds an `Effect.catch` handler that runs the plan-gate check on the caught
 * cause before delegating to the handler's error mapper. For sites whose gate
 * is only detectable via the server envelope (the domains family, vanity get),
 * omit `featureKey`.
 */
export const legacyGateMapError =
  <E, R2>(
    opts: { readonly projectRef: string; readonly featureKey?: string },
    mapError: (cause: SupabaseApiError) => Effect.Effect<never, E, R2>,
  ) =>
  (cause: SupabaseApiError) =>
    Effect.gen(function* () {
      const response = legacyGateResponse(cause);
      yield* legacySuggestUpgrade({
        projectRef: opts.projectRef,
        featureKey: opts.featureKey,
        statusCode: response?.status ?? 0,
        response,
      });
      return yield* mapError(cause);
    });

/**
 * Reproduces `apps/cli-go/internal/utils/plan_gate.go:SuggestUpgradeOnError`:
 *
 *   - Skip non-4xx statuses (2xx / 5xx).
 *   - Envelope first: when `response` carries the `entitlement_required` body,
 *     print the billing-link suggestion from its `upgrade_url` with zero extra
 *     API calls; telemetry `feature_key` comes from the envelope and `org_slug`
 *     from the URL's `/org/<slug>/` segment.
 *   - Fallback (only when `featureKey` is provided): GET `/v1/projects/{ref}`
 *     → `organization_slug`, then GET `/v1/organizations/{slug}/entitlements`
 *     → look for the requested feature key with `hasAccess: false`.
 *   - On gated: write the billing-link suggestion to stderr (text mode only,
 *     matches Go's `CmdSuggestion` print) **and** fire the
 *     `cli_upgrade_suggested` telemetry event with `{feature_key, org_slug}`.
 *
 * Never fails the caller; lookup and parse errors swallow into a no-op.
 *
 * The fallback bypasses the typed Management API client to GET
 * `/v1/projects/{ref}` and `/v1/organizations/{slug}/entitlements` directly
 * via `HttpClient`. The generated `V1GetProjectOutput` schema enforces
 * `ref: isMinLength(20)`, which the cli-e2e replay fixtures cannot satisfy
 * (they embed the literal 15-char `__PROJECT_REF__` placeholder in response
 * bodies). Strict decode would fail silently inside `Effect.option`, the
 * entitlements GET would be skipped, and parity with Go's request log would
 * break. Same workaround used by `legacy-linked-project-cache.layer.ts`.
 */
export const legacySuggestUpgrade = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
  /**
   * Entitlements-fallback feature key. Omit for envelope-only sites (the
   * domains family and vanity get): their gates are add-on or read-path
   * checks the plan-level entitlement key cannot represent, so the fallback
   * would false-positive on unrelated 4xxs.
   */
  readonly featureKey?: string;
  readonly statusCode: number;
  /** The failed response; enables the zero-round-trip envelope path. */
  readonly response?: HttpClientResponse.HttpClientResponse;
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

  let gate:
    | { readonly billingUrl: string; readonly feature: string; readonly orgSlug: string }
    | undefined;

  if (opts.response !== undefined) {
    const body = yield* opts.response.json.pipe(Effect.option);
    const envelope = Option.isSome(body) ? parseLegacyPlanGateEnvelope(body.value) : undefined;
    if (envelope !== undefined) {
      gate = {
        billingUrl: envelope.upgradeUrl,
        feature: envelope.feature,
        orgSlug: legacyOrgSlugFromUpgradeUrl(envelope.upgradeUrl),
      };
    }
  }

  if (gate === undefined) {
    if (opts.featureKey === undefined) {
      return;
    }

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

    gate = {
      billingUrl: legacyBillingUrl(cliConfig.profile, orgSlug),
      feature: opts.featureKey,
      orgSlug,
    };
  }

  const suggestion = `Your organization does not have access to this feature. Upgrade your plan: ${styleText("bold", gate.billingUrl)}`;

  if (output.format === "text") {
    yield* output.raw(suggestion + "\n", "stderr");
  }

  if (opts.trackAnalytics !== false) {
    yield* analytics.capture(EventUpgradeSuggested, {
      [PropFeatureKey]: gate.feature,
      [PropOrgSlug]: gate.orgSlug,
    });
  }
});
