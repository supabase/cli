import { Effect } from "effect";

import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import {
  EventUpgradeSuggested,
  PropFeatureKey,
  PropOrgSlug,
} from "../../shared/telemetry/event-catalog.ts";
import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";

/**
 * Mirrors Go's `utils.SuggestUpgradeOnError` + `telemetry.TrackUpgradeSuggested`
 * (`apps/cli-go/internal/utils/plan_gate.go:28-53`,
 * `apps/cli-go/internal/telemetry/events.go:56-63`).
 *
 *  - Only runs for 4xx (`>= 400 && < 500`). 2xx and 5xx are no-ops.
 *  - Fetches the project to resolve `organization_slug`. Transport / non-200
 *    failures are swallowed silently (matches Go's two-level early-return).
 *  - Fetches organization entitlements; scans for the requested feature key
 *    with `hasAccess === false`.
 *  - On a positive gate match, fires `cli_upgrade_suggested` with the
 *    feature key and org slug.
 *  - Every failure mode is swallowed: this is best-effort telemetry that
 *    must never derail the command's primary error reporting. The return
 *    type's error channel is `never`.
 *
 * Hoisted to `legacy/telemetry/` (not the sso command directory) because
 * the branches/{create,update} ports will reuse it.
 */
export const suggestUpgradeOnError = (
  projectRef: string,
  featureKey: string,
  statusCode: number,
): Effect.Effect<void, never, LegacyPlatformApi | Analytics> =>
  Effect.gen(function* () {
    if (statusCode < 400 || statusCode >= 500) return;
    const api = yield* LegacyPlatformApi;
    const analytics = yield* Analytics;

    const project = yield* api.v1.getProject({ ref: projectRef }).pipe(Effect.option);
    if (project._tag === "None") return;
    const orgSlug = project.value.organization_slug;
    if (typeof orgSlug !== "string" || orgSlug.length === 0) return;

    const entitlements = yield* api.v1
      .getOrganizationEntitlements({ slug: orgSlug })
      .pipe(Effect.option);
    if (entitlements._tag === "None") return;

    const gated = entitlements.value.entitlements.some(
      (e) => e.feature.key === featureKey && e.hasAccess === false,
    );
    if (!gated) return;

    yield* analytics.capture(EventUpgradeSuggested, {
      [PropFeatureKey]: featureKey,
      [PropOrgSlug]: orgSlug,
    });
  }).pipe(Effect.catch(() => Effect.void));
