package tenant

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/oapi-codegen/nullable"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestApiKey(t *testing.T) {
	t.Run("creates api key from response", func(t *testing.T) {
		resp := []api.ApiKeyResponse{
			{Name: "anon", ApiKey: nullable.NewNullableWithValue("anon-key")},
			{Name: "service_role", ApiKey: nullable.NewNullableWithValue("service-key")},
		}

		keys := NewApiKey(resp)

		assert.Equal(t, "anon-key", keys.Anon)
		assert.Equal(t, "service-key", keys.ServiceRole)
		assert.False(t, keys.IsEmpty())
	})

	t.Run("handles empty response", func(t *testing.T) {
		resp := []api.ApiKeyResponse{
			{Name: "service_role", ApiKey: nullable.NewNullNullable[string]()},
		}

		keys := NewApiKey(resp)

		assert.Empty(t, keys.Anon)
		assert.Empty(t, keys.ServiceRole)
		assert.True(t, keys.IsEmpty())
	})

	t.Run("handles partial response", func(t *testing.T) {
		resp := []api.ApiKeyResponse{
			{Name: "anon", ApiKey: nullable.NewNullableWithValue("anon-key")},
		}

		keys := NewApiKey(resp)

		assert.Equal(t, "anon-key", keys.Anon)
		assert.Empty(t, keys.ServiceRole)
		assert.False(t, keys.IsEmpty())
	})
}

func TestGetApiKeys(t *testing.T) {
	t.Run("retrieves api keys successfully", func(t *testing.T) {
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		defer gock.OffAll()
		projectRef := apitest.RandomProjectRef()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{
				{Name: "anon", ApiKey: nullable.NewNullableWithValue("anon-key")},
				{Name: "service_role", ApiKey: nullable.NewNullableWithValue("service-key")},
			})

		keys, err := GetApiKeys(context.Background(), projectRef)

		assert.NoError(t, err)
		assert.Equal(t, "anon-key", keys.Anon)
		assert.Equal(t, "service-key", keys.ServiceRole)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles network error", func(t *testing.T) {
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		defer gock.OffAll()
		projectRef := apitest.RandomProjectRef()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			ReplyError(gock.ErrCannotMatch)

		keys, err := GetApiKeys(context.Background(), projectRef)

		assert.Error(t, err)
		assert.Contains(t, err.Error(), "failed to get api keys")
		assert.True(t, keys.IsEmpty())
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles unauthorized error", func(t *testing.T) {
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		defer gock.OffAll()
		projectRef := apitest.RandomProjectRef()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusUnauthorized).
			JSON(map[string]string{"message": "unauthorized"})

		keys, err := GetApiKeys(context.Background(), projectRef)

		assert.ErrorIs(t, err, ErrAuthToken)
		assert.True(t, keys.IsEmpty())
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles missing anon key", func(t *testing.T) {
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		defer gock.OffAll()
		projectRef := apitest.RandomProjectRef()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{}) // should this error if response has only service_role key?

		keys, err := GetApiKeys(context.Background(), projectRef)

		assert.ErrorIs(t, err, errMissingKey)
		assert.True(t, keys.IsEmpty())
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestNewTenantAPI(t *testing.T) {
	t.Run("creates tenant api client", func(t *testing.T) {
		projectRef := apitest.RandomProjectRef()
		anonKey := "test-key"

		api := NewTenantAPI(context.Background(), projectRef, anonKey)

		assert.NotNil(t, api.Fetcher)

		defer gock.OffAll()
		gock.New("https://"+utils.GetSupabaseHost(projectRef)).
			Get("/test").
			MatchHeader("apikey", anonKey).
			MatchHeader("User-Agent", "SupabaseCLI/"+utils.Version).
			Reply(http.StatusOK)

		_, err := api.Send(context.Background(), http.MethodGet, "/test", nil)

		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
