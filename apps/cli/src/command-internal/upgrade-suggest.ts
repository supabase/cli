import { styleText } from "node:util";

import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, type Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { CommandSettings } from "../config/command-settings.service.ts";
import { resolveAccessToken } from "./resolve-token.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import {
  EventUpgradeSuggested,
  PropFeatureKey,
  PropOrgSlug,
} from "../shared/telemetry/event-catalog.ts";
import { Output } from "../shared/output/output.service.ts";
import { billingUrl } from "./profile.ts";

function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

interface PlanGateEnvelope {
  readonly feature: string;
  readonly upgradeUrl: string;
}

// Hand-validated: the packages/api codegen emits no non-2xx schemas.
function parsePlanGateEnvelope(body: unknown): PlanGateEnvelope | undefined {
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

function orgSlugFromUpgradeUrl(upgradeUrl: string): string {
  const match = /\/org\/([^/]+)/.exec(upgradeUrl);
  return match?.[1] ?? "";
}

export function gateResponse(cause: unknown): HttpClientResponse.HttpClientResponse | undefined {
  return HttpClientError.isHttpClientError(cause) ? cause.response : undefined;
}

export const gateMapError =
  <E, R2>(
    opts: { readonly projectRef: string; readonly featureKey?: string },
    mapError: (cause: SupabaseApiError, upgradeSuggested: boolean) => Effect.Effect<never, E, R2>,
  ) =>
  (cause: SupabaseApiError) =>
    Effect.gen(function* () {
      const response = gateResponse(cause);
      const upgradeSuggested = yield* suggestUpgrade({
        projectRef: opts.projectRef,
        featureKey: opts.featureKey,
        statusCode: response?.status ?? 0,
        response,
      });
      return yield* mapError(cause, upgradeSuggested);
    });

/**
 * Suggests an upgrade when a request fails with a plan-gate error. Never
 * fails the caller.
 *
 * The fallback bypasses the typed API client, whose strict response schemas
 * reject the cli-e2e replay fixtures' placeholder refs (same workaround as
 * `linked-project-cache.layer.ts`). Returns whether the feature was
 * confirmed plan-gated.
 */
export const suggestUpgrade = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
  /**
   * Entitlements-fallback key. Omit for envelope-only sites: the domains
   * add-on gate has no plan-level entitlement key, so the fallback would
   * false-positive on unrelated 4xxs.
   */
  readonly featureKey?: string;
  readonly statusCode: number;
  readonly response?: HttpClientResponse.HttpClientResponse;
  /**
   * Overrides the API base URL of the fallback project + entitlement GETs,
   * for commands that reconcile a profile differing from the config layer's
   * (sso add/update), so the gate requests hit the same host as their main
   * calls. Defaults to `CommandSettings.apiUrl`.
   */
  readonly apiUrl?: string;
  /**
   * Overrides the bearer token of the fallback GETs, complementing `apiUrl`:
   * a caller passing a reconciled `apiUrl` must also pass that profile's
   * token, or the stale profile's token would reach the reconciled host.
   * `Some` uses that token, `None` sends unauthenticated, `undefined`
   * resolves from the service.
   */
  readonly accessToken?: Option.Option<Redacted.Redacted<string>>;
  /** Set false for call sites that must not fire `EventUpgradeSuggested` (vanity check-availability). */
  readonly trackAnalytics?: boolean;
}) {
  if (opts.statusCode < 400 || opts.statusCode >= 500) {
    return false;
  }

  const output = yield* Output;
  const analytics = yield* Analytics;
  const cliSettings = yield* CommandSettings;
  const httpClient = yield* HttpClient.HttpClient;

  let gate:
    | { readonly billingUrl: string; readonly feature: string; readonly orgSlug: string }
    | undefined;

  if (opts.response !== undefined) {
    const body = yield* opts.response.json.pipe(Effect.option);
    const envelope = Option.isSome(body) ? parsePlanGateEnvelope(body.value) : undefined;
    if (envelope !== undefined) {
      gate = {
        billingUrl: envelope.upgradeUrl,
        feature: envelope.feature,
        orgSlug: orgSlugFromUpgradeUrl(envelope.upgradeUrl),
      };
    }
  }

  if (gate === undefined) {
    if (opts.featureKey === undefined || opts.featureKey === "") {
      return false;
    }

    const tokenOpt = opts.accessToken ?? (yield* resolveAccessToken);
    const authHeader: (
      req: HttpClientRequest.HttpClientRequest,
    ) => HttpClientRequest.HttpClientRequest = Option.isSome(tokenOpt)
      ? HttpClientRequest.bearerToken(tokenOpt.value)
      : (req) => req;

    const apiUrl = opts.apiUrl ?? cliSettings.apiUrl;
    const projectReq = HttpClientRequest.get(`${apiUrl}/v1/projects/${opts.projectRef}`).pipe(
      authHeader,
      HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
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
      HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
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

    gate = {
      billingUrl: billingUrl(cliSettings.profile, orgSlug),
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

  return true;
});
