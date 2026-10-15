import { styleText } from "node:util";

import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, type Redacted } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import {
  EventUpgradeSuggested,
  PropFeatureKey,
  PropOrgSlug,
} from "../shared/telemetry/event-catalog.ts";
import { Output } from "../shared/output/output.service.ts";
import { billingUrl } from "./profile.ts";
import { block } from "./command-permissions/model.ts";

/** `suggestUpgrade`'s entitlement lookup. */
export const upgradeSuggestion = block("upgrade-suggest", [
  {
    operationId: "v1-get-project",
    kind: "best-effort",
    context:
      "after a 4xx response that carries no plan-gate error, at a call site that names a feature",
  },
  {
    operationId: "v1-get-organization-entitlements",
    kind: "best-effort",
    context:
      "after a 4xx response that carries no plan-gate error, at a call site that names a feature",
  },
]);

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
 * Returns whether the feature was confirmed plan-gated.
 */
export const suggestUpgrade = Effect.fn("UpgradeSuggest.check")(function* (opts: {
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
   * `Some` uses that token, `None` skips the fallback (the client cannot send
   * an unauthenticated request), `undefined` uses the client's own token.
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
  yield* Effect.annotateCurrentSpan("upgrade.gated", false);

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

    if (opts.accessToken !== undefined && Option.isNone(opts.accessToken)) {
      return false;
    }

    const api = yield* CommandPlatformApi;
    const requestOptions = {
      baseUrl: opts.apiUrl,
      accessToken: opts.accessToken === undefined ? undefined : opts.accessToken.value,
    };
    const project = yield* api.v1
      .getProject({ ref: opts.projectRef }, requestOptions)
      .pipe(Effect.option);
    if (Option.isNone(project)) {
      return false;
    }
    const orgSlug = project.value.organization_slug;
    if (orgSlug.length === 0) {
      return false;
    }

    const entitlements = yield* api.v1
      .getOrganizationEntitlements({ slug: orgSlug }, requestOptions)
      .pipe(Effect.option);
    if (Option.isNone(entitlements)) {
      return false;
    }

    const gated = entitlements.value.entitlements.some(
      (entry) => entry.feature.key === opts.featureKey && entry.hasAccess === false,
    );
    if (!gated) {
      return false;
    }

    gate = {
      billingUrl: billingUrl(cliSettings.profile, orgSlug),
      feature: opts.featureKey,
      orgSlug,
    };
  }

  yield* Effect.annotateCurrentSpan("upgrade.gated", true);
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
