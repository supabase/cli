package utils

import (
	"context"
	"fmt"
)

func GetOrgSlugFromProjectRef(ctx context.Context, projectRef string) (string, error) {
	resp, err := GetSupabase().V1GetProjectWithResponse(ctx, projectRef)
	if err != nil {
		return "", fmt.Errorf("failed to get project: %w", err)
	}
	if resp.JSON200 == nil {
		return "", fmt.Errorf("unexpected get project status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return resp.JSON200.OrganizationSlug, nil
}

func GetOrgBillingURL(orgSlug string) string {
	return fmt.Sprintf("%s/org/%s/billing", GetSupabaseDashboardURL(), orgSlug)
}

// SuggestUpgradeOnError checks if a failed API response is due to plan limitations
// by looking up the org's entitlements. Only sets CmdSuggestion when the entitlements
// API confirms the feature is gated (hasAccess == false). Returns the resolved org
// slug and true if a billing suggestion was shown (so callers can fire telemetry).
// Only checks on 4xx client errors; skips 2xx (success) and 5xx (server errors).
func SuggestUpgradeOnError(ctx context.Context, projectRef, featureKey string, statusCode int) (orgSlug string, isGated bool) {
	if statusCode < 400 || statusCode >= 500 {
		return
	}

	orgSlug, err := GetOrgSlugFromProjectRef(ctx, projectRef)
	if err != nil {
		return
	}

	resp, err := GetSupabase().V1GetOrganizationEntitlementsWithResponse(ctx, orgSlug)
	if err != nil || resp.JSON200 == nil {
		return
	}

	for _, e := range resp.JSON200.Entitlements {
		if string(e.Feature.Key) == featureKey && !e.HasAccess {
			billingURL := GetOrgBillingURL(orgSlug)
			CmdSuggestion = fmt.Sprintf("Your organization does not have access to this feature. Upgrade your plan: %s", Bold(billingURL))
			isGated = true
			return
		}
	}

	return
}
