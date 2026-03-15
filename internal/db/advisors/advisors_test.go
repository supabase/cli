package advisors

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestQueryLints(t *testing.T) {
	t.Run("parses lint results from local database", func(t *testing.T) {
		utils.Config.Hostname = "127.0.0.1"
		utils.Config.Db.Port = 5432
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("begin").Reply("BEGIN").
			Query(lintsSQL).
			Reply("SELECT 1",
				[]any{
					"rls_disabled_in_public",
					"RLS disabled in public",
					"ERROR",
					"EXTERNAL",
					[]string{"SECURITY"},
					"Detects tables in the public schema without RLS.",
					"Table public.users has RLS disabled",
					"https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public",
					[]byte(`{"schema":"public","name":"users","type":"table"}`),
					"rls_disabled_in_public_public_users",
				},
			).
			Query("rollback").Reply("ROLLBACK")
		// Run test
		lints, err := queryLints(context.Background(), conn.MockClient(t))
		require.NoError(t, err)
		require.Len(t, lints, 1)
		assert.Equal(t, "rls_disabled_in_public", lints[0].Name)
		assert.Equal(t, "ERROR", lints[0].Level)
		assert.Equal(t, []string{"SECURITY"}, lints[0].Categories)
	})

	t.Run("handles empty results", func(t *testing.T) {
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("begin").Reply("BEGIN").
			Query(lintsSQL).
			Reply("SELECT 0").
			Query("rollback").Reply("ROLLBACK")
		// Run test
		lints, err := queryLints(context.Background(), conn.MockClient(t))
		require.NoError(t, err)
		assert.Empty(t, lints)
	})

	t.Run("handles query error", func(t *testing.T) {
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("begin").Reply("BEGIN").
			Query(lintsSQL).
			ReplyError("42601", "syntax error").
			Query("rollback").Reply("ROLLBACK")
		// Run test
		_, err := queryLints(context.Background(), conn.MockClient(t))
		assert.Error(t, err)
	})
}

func TestFilterLints(t *testing.T) {
	lints := []Lint{
		{Name: "rls_disabled", Level: "ERROR", Categories: []string{"SECURITY"}},
		{Name: "unindexed_fk", Level: "INFO", Categories: []string{"PERFORMANCE"}},
		{Name: "auth_exposed", Level: "WARN", Categories: []string{"SECURITY"}},
		{Name: "no_primary_key", Level: "WARN", Categories: []string{"PERFORMANCE"}},
	}

	t.Run("filters by type security", func(t *testing.T) {
		filtered := filterLints(lints, "security", "info")
		assert.Len(t, filtered, 2)
		assert.Equal(t, "rls_disabled", filtered[0].Name)
		assert.Equal(t, "auth_exposed", filtered[1].Name)
	})

	t.Run("filters by type performance", func(t *testing.T) {
		filtered := filterLints(lints, "performance", "info")
		assert.Len(t, filtered, 2)
		assert.Equal(t, "unindexed_fk", filtered[0].Name)
		assert.Equal(t, "no_primary_key", filtered[1].Name)
	})

	t.Run("filters by type all", func(t *testing.T) {
		filtered := filterLints(lints, "all", "info")
		assert.Len(t, filtered, 4)
	})

	t.Run("filters by level warn", func(t *testing.T) {
		filtered := filterLints(lints, "all", "warn")
		assert.Len(t, filtered, 3)
	})

	t.Run("filters by level error", func(t *testing.T) {
		filtered := filterLints(lints, "all", "error")
		assert.Len(t, filtered, 1)
		assert.Equal(t, "rls_disabled", filtered[0].Name)
	})

	t.Run("combines type and level filters", func(t *testing.T) {
		filtered := filterLints(lints, "security", "error")
		assert.Len(t, filtered, 1)
		assert.Equal(t, "rls_disabled", filtered[0].Name)
	})
}

func TestOutputAndCheck(t *testing.T) {
	lints := []Lint{
		{Name: "rls_disabled", Level: "ERROR", Categories: []string{"SECURITY"}, Title: "RLS disabled"},
		{Name: "unindexed_fk", Level: "WARN", Categories: []string{"PERFORMANCE"}, Title: "Unindexed FK"},
	}

	t.Run("outputs json", func(t *testing.T) {
		var out bytes.Buffer
		err := outputAndCheck(lints, "none", &out)
		assert.NoError(t, err)
		// Validate JSON output
		var result []Lint
		assert.NoError(t, json.Unmarshal(out.Bytes(), &result))
		assert.Len(t, result, 2)
	})

	t.Run("no issues prints message", func(t *testing.T) {
		var out bytes.Buffer
		err := outputAndCheck(nil, "none", &out)
		assert.NoError(t, err)
		assert.Empty(t, out.String())
	})

	t.Run("fail-on error triggers on error level", func(t *testing.T) {
		var out bytes.Buffer
		err := outputAndCheck(lints, "error", &out)
		assert.ErrorContains(t, err, "fail-on is set to error, non-zero exit")
	})

	t.Run("fail-on warn triggers on warn level", func(t *testing.T) {
		var out bytes.Buffer
		err := outputAndCheck(lints, "warn", &out)
		assert.ErrorContains(t, err, "fail-on is set to warn, non-zero exit")
	})

	t.Run("fail-on error does not trigger on warn only", func(t *testing.T) {
		warnOnly := []Lint{
			{Name: "unindexed_fk", Level: "WARN", Categories: []string{"PERFORMANCE"}},
		}
		var out bytes.Buffer
		err := outputAndCheck(warnOnly, "error", &out)
		assert.NoError(t, err)
	})
}

func TestApiResponseToLints(t *testing.T) {
	t.Run("converts API response to lints", func(t *testing.T) {
		resp := &api.V1ProjectAdvisorsResponse{
			Lints: []struct {
				CacheKey    string                                         `json:"cache_key"`
				Categories  []api.V1ProjectAdvisorsResponseLintsCategories `json:"categories"`
				Description string                                         `json:"description"`
				Detail      string                                         `json:"detail"`
				Facing      api.V1ProjectAdvisorsResponseLintsFacing       `json:"facing"`
				Level       api.V1ProjectAdvisorsResponseLintsLevel        `json:"level"`
				Metadata    *struct {
					Entity      *string                                         `json:"entity,omitempty"`
					FkeyColumns *[]float32                                      `json:"fkey_columns,omitempty"`
					FkeyName    *string                                         `json:"fkey_name,omitempty"`
					Name        *string                                         `json:"name,omitempty"`
					Schema      *string                                         `json:"schema,omitempty"`
					Type        *api.V1ProjectAdvisorsResponseLintsMetadataType `json:"type,omitempty"`
				} `json:"metadata,omitempty"`
				Name        api.V1ProjectAdvisorsResponseLintsName `json:"name"`
				Remediation string                                 `json:"remediation"`
				Title       string                                 `json:"title"`
			}{
				{
					Name:        api.RlsDisabledInPublic,
					Title:       "RLS disabled in public",
					Level:       api.ERROR,
					Facing:      api.EXTERNAL,
					Categories:  []api.V1ProjectAdvisorsResponseLintsCategories{api.SECURITY},
					Description: "Tables without RLS",
					Detail:      "Table public.users",
					Remediation: "https://supabase.com/docs",
					CacheKey:    "test_key",
				},
			},
		}
		lints := apiResponseToLints(resp)
		require.Len(t, lints, 1)
		assert.Equal(t, "rls_disabled_in_public", lints[0].Name)
		assert.Equal(t, "ERROR", lints[0].Level)
		assert.Equal(t, []string{"SECURITY"}, lints[0].Categories)
	})
}

func TestFetchLinkedAdvisors(t *testing.T) {
	projectRef := apitest.RandomProjectRef()

	t.Run("fetches security advisors", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/advisors/security").
			Reply(http.StatusOK).
			JSON(api.V1ProjectAdvisorsResponse{
				Lints: []struct {
					CacheKey    string                                         `json:"cache_key"`
					Categories  []api.V1ProjectAdvisorsResponseLintsCategories `json:"categories"`
					Description string                                         `json:"description"`
					Detail      string                                         `json:"detail"`
					Facing      api.V1ProjectAdvisorsResponseLintsFacing       `json:"facing"`
					Level       api.V1ProjectAdvisorsResponseLintsLevel        `json:"level"`
					Metadata    *struct {
						Entity      *string                                         `json:"entity,omitempty"`
						FkeyColumns *[]float32                                      `json:"fkey_columns,omitempty"`
						FkeyName    *string                                         `json:"fkey_name,omitempty"`
						Name        *string                                         `json:"name,omitempty"`
						Schema      *string                                         `json:"schema,omitempty"`
						Type        *api.V1ProjectAdvisorsResponseLintsMetadataType `json:"type,omitempty"`
					} `json:"metadata,omitempty"`
					Name        api.V1ProjectAdvisorsResponseLintsName `json:"name"`
					Remediation string                                 `json:"remediation"`
					Title       string                                 `json:"title"`
				}{
					{
						Name:       api.RlsDisabledInPublic,
						Title:      "RLS disabled",
						Level:      api.ERROR,
						Facing:     api.EXTERNAL,
						Categories: []api.V1ProjectAdvisorsResponseLintsCategories{api.SECURITY},
					},
				},
			})
		lints, err := fetchSecurityAdvisors(context.Background(), projectRef)
		require.NoError(t, err)
		assert.Len(t, lints, 1)
	})

	t.Run("fetches performance advisors", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/advisors/performance").
			Reply(http.StatusOK).
			JSON(api.V1ProjectAdvisorsResponse{
				Lints: []struct {
					CacheKey    string                                         `json:"cache_key"`
					Categories  []api.V1ProjectAdvisorsResponseLintsCategories `json:"categories"`
					Description string                                         `json:"description"`
					Detail      string                                         `json:"detail"`
					Facing      api.V1ProjectAdvisorsResponseLintsFacing       `json:"facing"`
					Level       api.V1ProjectAdvisorsResponseLintsLevel        `json:"level"`
					Metadata    *struct {
						Entity      *string                                         `json:"entity,omitempty"`
						FkeyColumns *[]float32                                      `json:"fkey_columns,omitempty"`
						FkeyName    *string                                         `json:"fkey_name,omitempty"`
						Name        *string                                         `json:"name,omitempty"`
						Schema      *string                                         `json:"schema,omitempty"`
						Type        *api.V1ProjectAdvisorsResponseLintsMetadataType `json:"type,omitempty"`
					} `json:"metadata,omitempty"`
					Name        api.V1ProjectAdvisorsResponseLintsName `json:"name"`
					Remediation string                                 `json:"remediation"`
					Title       string                                 `json:"title"`
				}{
					{
						Name:       api.UnindexedForeignKeys,
						Title:      "Unindexed FK",
						Level:      api.INFO,
						Facing:     api.EXTERNAL,
						Categories: []api.V1ProjectAdvisorsResponseLintsCategories{api.PERFORMANCE},
					},
				},
			})
		lints, err := fetchPerformanceAdvisors(context.Background(), projectRef)
		require.NoError(t, err)
		assert.Len(t, lints, 1)
	})

	t.Run("handles API error", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/advisors/security").
			Reply(http.StatusInternalServerError).
			JSON(map[string]string{"error": "internal error"})
		_, err := fetchSecurityAdvisors(context.Background(), projectRef)
		assert.Error(t, err)
	})
}
