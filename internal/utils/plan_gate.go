package utils

import (
	"context"
	"fmt"
	"net/http"
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
// and sets CmdSuggestion with a billing upgrade link. Best-effort: never returns errors.
// Only triggers on 402 Payment Required (not 403, which could be a permissions issue).
func SuggestUpgradeOnError(ctx context.Context, projectRef, featureKey string, statusCode int) {
	if statusCode != http.StatusPaymentRequired {
		return
	}

	orgSlug, err := GetOrgSlugFromProjectRef(ctx, projectRef)
	if err != nil {
		CmdSuggestion = fmt.Sprintf("This feature may require a plan upgrade. Manage billing: %s", Bold(GetSupabaseDashboardURL()))
		return
	}

	billingURL := GetOrgBillingURL(orgSlug)

	resp, err := GetSupabase().V1GetOrganizationEntitlementsWithResponse(ctx, orgSlug)
	if err != nil || resp.JSON200 == nil {
		CmdSuggestion = fmt.Sprintf("This feature may require a plan upgrade. Manage billing: %s", Bold(billingURL))
		return
	}

	for _, e := range resp.JSON200.Entitlements {
		if string(e.Feature.Key) == featureKey && !e.HasAccess {
			CmdSuggestion = fmt.Sprintf("Your organization does not have access to this feature. Upgrade your plan: %s", Bold(billingURL))
			return
		}
	}

	CmdSuggestion = fmt.Sprintf("This feature may require a plan upgrade. Manage billing: %s", Bold(billingURL))
}
