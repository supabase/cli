package utils

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
)

var planGateProjectJSON = map[string]interface{}{
	"ref":               "test-ref",
	"organization_slug": "my-org",
	"name":              "test",
	"region":            "us-east-1",
	"created_at":        "2024-01-01T00:00:00Z",
	"status":            "ACTIVE_HEALTHY",
	"database":          map[string]interface{}{"host": "db.example.supabase.co", "version": "15.1.0.117"},
}

func TestGetOrgSlugFromProjectRef(t *testing.T) {
	ref := apitest.RandomProjectRef()

	t.Run("returns org slug on success", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(DefaultApiHost).
			Get("/v1/projects/" + ref).
			Reply(http.StatusOK).
			JSON(planGateProjectJSON)
		slug, err := GetOrgSlugFromProjectRef(context.Background(), ref)
		assert.NoError(t, err)
		assert.Equal(t, "my-org", slug)
	})

	t.Run("returns error on not found", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(DefaultApiHost).
			Get("/v1/projects/" + ref).
			Reply(http.StatusNotFound)
		_, err := GetOrgSlugFromProjectRef(context.Background(), ref)
		assert.ErrorContains(t, err, "unexpected get project status 404")
	})

	t.Run("returns error on network failure", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(DefaultApiHost).
			Get("/v1/projects/" + ref).
			ReplyError(assert.AnError)
		_, err := GetOrgSlugFromProjectRef(context.Background(), ref)
		assert.ErrorContains(t, err, "failed to get project")
	})
}

func TestGetOrgBillingURL(t *testing.T) {
	url := GetOrgBillingURL("my-org")
	assert.Equal(t, GetSupabaseDashboardURL()+"/org/my-org/billing", url)
}

func entitlementsJSON(featureKey string, hasAccess bool) map[string]interface{} {
	return map[string]interface{}{
		"entitlements": []map[string]interface{}{
			{
				"feature":   map[string]interface{}{"key": featureKey, "type": "numeric"},
				"hasAccess": hasAccess,
				"type":      "numeric",
				"config":    map[string]interface{}{"enabled": hasAccess, "value": 0, "unlimited": false, "unit": "count"},
			},
		},
	}
}

// mockEntitlementsCheck sets up gock mocks for project lookup + entitlements.
func mockEntitlementsCheck(ref string, featureKey string, hasAccess bool) {
	gock.New(DefaultApiHost).
		Get("/v1/projects/" + ref).
		Reply(http.StatusOK).
		JSON(planGateProjectJSON)
	gock.New(DefaultApiHost).
		Get("/v1/organizations/my-org/entitlements").
		Reply(http.StatusOK).
		JSON(entitlementsJSON(featureKey, hasAccess))
}

func TestSuggestUpgradeOnError(t *testing.T) {
	ref := apitest.RandomProjectRef()

	t.Run("sets suggestion on 402 with gated feature", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		t.Cleanup(func() { CmdSuggestion = "" })
		mockEntitlementsCheck(ref, "branching_limit", false)
		slug, got := SuggestUpgradeOnError(context.Background(), ref, "branching_limit", http.StatusPaymentRequired)
		assert.True(t, got)
		assert.Equal(t, "my-org", slug)
		assert.Contains(t, CmdSuggestion, "/org/my-org/billing")
		assert.Contains(t, CmdSuggestion, "does not have access")
	})

	t.Run("sets suggestion on 400 with gated feature", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		t.Cleanup(func() { CmdSuggestion = "" })
		mockEntitlementsCheck(ref, "vanity_subdomain", false)
		slug, got := SuggestUpgradeOnError(context.Background(), ref, "vanity_subdomain", http.StatusBadRequest)
		assert.True(t, got)
		assert.Equal(t, "my-org", slug)
		assert.Contains(t, CmdSuggestion, "/org/my-org/billing")
		assert.Contains(t, CmdSuggestion, "does not have access")
	})

	t.Run("sets suggestion on 404 with gated feature", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		t.Cleanup(func() { CmdSuggestion = "" })
		mockEntitlementsCheck(ref, "auth.saml_2", false)
		slug, got := SuggestUpgradeOnError(context.Background(), ref, "auth.saml_2", http.StatusNotFound)
		assert.True(t, got)
		assert.Equal(t, "my-org", slug)
		assert.Contains(t, CmdSuggestion, "/org/my-org/billing")
	})

	t.Run("no suggestion when entitlements lookup fails", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		t.Cleanup(func() { CmdSuggestion = "" })
		gock.New(DefaultApiHost).
			Get("/v1/projects/" + ref).
			Reply(http.StatusOK).
			JSON(planGateProjectJSON)
		gock.New(DefaultApiHost).
			Get("/v1/organizations/my-org/entitlements").
			Reply(http.StatusInternalServerError)
		slug, got := SuggestUpgradeOnError(context.Background(), ref, "branching_limit", http.StatusPaymentRequired)
		assert.False(t, got)
		assert.Equal(t, "my-org", slug)
		assert.Empty(t, CmdSuggestion)
	})

	t.Run("no suggestion when project lookup fails", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		t.Cleanup(func() { CmdSuggestion = "" })
		gock.New(DefaultApiHost).
			Get("/v1/projects/" + ref).
			Reply(http.StatusNotFound)
		slug, got := SuggestUpgradeOnError(context.Background(), ref, "branching_limit", http.StatusPaymentRequired)
		assert.False(t, got)
		assert.Empty(t, slug)
		assert.Empty(t, CmdSuggestion)
	})

	t.Run("no suggestion when feature has access", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		t.Cleanup(func() { CmdSuggestion = "" })
		mockEntitlementsCheck(ref, "branching_limit", true)
		slug, got := SuggestUpgradeOnError(context.Background(), ref, "branching_limit", http.StatusPaymentRequired)
		assert.False(t, got)
		assert.Equal(t, "my-org", slug)
		assert.Empty(t, CmdSuggestion)
	})

	t.Run("skips on 200", func(t *testing.T) {
		CmdSuggestion = ""
		_, got := SuggestUpgradeOnError(context.Background(), ref, "branching_limit", http.StatusOK)
		assert.False(t, got)
		assert.Empty(t, CmdSuggestion)
	})

	t.Run("skips on 201", func(t *testing.T) {
		CmdSuggestion = ""
		_, got := SuggestUpgradeOnError(context.Background(), ref, "branching_limit", http.StatusCreated)
		assert.False(t, got)
		assert.Empty(t, CmdSuggestion)
	})
}
