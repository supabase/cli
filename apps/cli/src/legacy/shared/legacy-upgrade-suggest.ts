import { styleText } from "node:util";

import { Effect } from "effect";

import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import {
  EventUpgradeSuggested,
  PropFeatureKey,
  PropOrgSlug,
} from "../../shared/telemetry/event-catalog.ts";
import { Output } from "../../shared/output/output.service.ts";
import { legacyBillingUrl } from "./legacy-profile.ts";

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
 */
export const legacySuggestUpgrade = Effect.fnUntraced(function* (opts: {
  readonly projectRef: string;
  readonly featureKey: string;
  readonly statusCode: number;
}) {
  if (opts.statusCode < 400 || opts.statusCode >= 500) {
    return;
  }

  const api = yield* LegacyPlatformApi;
  const output = yield* Output;
  const analytics = yield* Analytics;
  const cliConfig = yield* LegacyCliConfig;

  const projectResp = yield* api.v1.getProject({ ref: opts.projectRef }).pipe(Effect.option);
  if (projectResp._tag === "None") {
    return;
  }
  const orgSlug = projectResp.value.organization_slug;

  const entitlementsResp = yield* api.v1
    .getOrganizationEntitlements({ slug: orgSlug })
    .pipe(Effect.option);
  if (entitlementsResp._tag === "None") {
    return;
  }

  const gated = entitlementsResp.value.entitlements.find(
    (entry) => entry.feature.key === opts.featureKey && !entry.hasAccess,
  );
  if (gated === undefined) {
    return;
  }

  const url = legacyBillingUrl(cliConfig.profile, orgSlug);
  const suggestion = `Your organization does not have access to this feature. Upgrade your plan: ${styleText("bold", url)}`;

  if (output.format === "text") {
    yield* output.raw(suggestion + "\n", "stderr");
  }

  yield* analytics.capture(EventUpgradeSuggested, {
    [PropFeatureKey]: opts.featureKey,
    [PropOrgSlug]: orgSlug,
  });
});
