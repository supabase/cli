package utils

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/supabase/cli/pkg/api"
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

func orgSlugFromBillingURL(billingURL string) string {
	const marker = "/org/"
	start := strings.Index(billingURL, marker)
	if start < 0 {
		return ""
	}
	rest := billingURL[start+len(marker):]
	if end := strings.Index(rest, "/"); end >= 0 {
		return rest[:end]
	}
	return rest
}

func parsePlanGateError(body []byte) (feature, upgradeURL string, ok bool) {
	var envelope api.PlanGateErrorBody
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Error == nil {
		return "", "", false
	}
	if envelope.Error.Code != api.EntitlementRequired || envelope.Error.Feature == "" {
		return "", "", false
	}
	if envelope.Error.UpgradeUrl == nil || *envelope.Error.UpgradeUrl == "" {
		return "", "", false
	}
	return envelope.Error.Feature, *envelope.Error.UpgradeUrl, true
}

func setUpgradeSuggestion(billingURL string) {
	CmdSuggestion = fmt.Sprintf("Your organization does not have access to this feature. Upgrade your plan: %s", Bold(billingURL))
}

// SuggestUpgradeOnError checks whether a failed API response is a plan gate and
// sets CmdSuggestion with the billing URL when it is. The entitlement_required
// envelope on the response body is authoritative and needs no network calls;
// when absent, a non-empty featureKey falls back to the entitlements lookup.
// An empty featureKey disables the fallback (envelope-only sites). Returns the
// effective feature and org slug for telemetry, and whether a suggestion was
// shown. Only fires on 4xx.
func SuggestUpgradeOnError(ctx context.Context, projectRef, featureKey string, statusCode int, body []byte) (gatedFeature, orgSlug string, isGated bool) {
	if statusCode < 400 || statusCode >= 500 {
		return "", "", false
	}

	if feature, upgradeURL, ok := parsePlanGateError(body); ok {
		setUpgradeSuggestion(upgradeURL)
		return feature, orgSlugFromBillingURL(upgradeURL), true
	}

	if featureKey == "" {
		return "", "", false
	}

	slug, err := GetOrgSlugFromProjectRef(ctx, projectRef)
	if err != nil {
		return "", "", false
	}

	resp, err := GetSupabase().V1GetOrganizationEntitlementsWithResponse(ctx, slug)
	if err != nil || resp.JSON200 == nil {
		return "", slug, false
	}

	for _, e := range resp.JSON200.Entitlements {
		if string(e.Feature.Key) == featureKey && !e.HasAccess {
			setUpgradeSuggestion(GetOrgBillingURL(slug))
			return featureKey, slug, true
		}
	}

	return "", slug, false
}
