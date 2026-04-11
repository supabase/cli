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
func SuggestUpgradeOnError(ctx context.Context, projectRef, featureKey string, statusCode int) (string, bool) {
	if statusCode >= 200 && statusCode < 300 {
		return "", false
	}

	orgSlug, err := GetOrgSlugFromProjectRef(ctx, projectRef)
	if err != nil {
		return "", false
	}

	billingURL := GetOrgBillingURL(orgSlug)

	resp, err := GetSupabase().V1GetOrganizationEntitlementsWithResponse(ctx, orgSlug)
	if err != nil || resp.JSON200 == nil {
		return orgSlug, false
	}

	for _, e := range resp.JSON200.Entitlements {
		if string(e.Feature.Key) == featureKey && !e.HasAccess {
			CmdSuggestion = fmt.Sprintf("Your organization does not have access to this feature. Upgrade your plan: %s", Bold(billingURL))
			return orgSlug, true
		}
	}

	return orgSlug, false
}
