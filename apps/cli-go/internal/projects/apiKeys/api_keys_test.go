package apiKeys

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/oapi-codegen/nullable"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestProjectApiKeysCommand(t *testing.T) {
	// Setup valid project ref
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("lists all api-keys", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{
				Name:   "Test ApiKey",
				ApiKey: nullable.NewNullableWithValue("dummy-api-key-value"),
			}, {
				Name:   "Test NullKey",
				ApiKey: nullable.NewNullNullable[string](),
			}})
		// Run test
		err := Run(context.Background(), project, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), project, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), project, fsys)
		// Check error
		assert.ErrorContains(t, err, "unexpected get api keys status 503:")
	})
}

func TestToEnv(t *testing.T) {
	t.Run("maps legacy keys by name only", func(t *testing.T) {
		envs := ToEnv([]api.ApiKeyResponse{{
			Name:   "anon",
			ApiKey: nullable.NewNullableWithValue("anon-key"),
		}, {
			Name:   "service_role",
			ApiKey: nullable.NewNullNullable[string](),
		}})
		assert.Equal(t, map[string]string{
			"SUPABASE_ANON_KEY":         "anon-key",
			"SUPABASE_SERVICE_ROLE_KEY": "******",
		}, envs)
	})

	t.Run("adds SUPABASE_PUBLISHABLE_KEY for new-format keys", func(t *testing.T) {
		envs := ToEnv([]api.ApiKeyResponse{{
			Name:   "default",
			Type:   nullable.NewNullableWithValue(api.ApiKeyResponseTypePublishable),
			ApiKey: nullable.NewNullableWithValue("sb_publishable_test"),
		}, {
			Name:   "default",
			Type:   nullable.NewNullableWithValue(api.ApiKeyResponseTypeSecret),
			ApiKey: nullable.NewNullableWithValue("sb_secret_test"),
		}})
		assert.Equal(t, "sb_publishable_test", envs["SUPABASE_PUBLISHABLE_KEY"])
		assert.Equal(t, "sb_secret_test", envs["SUPABASE_DEFAULT_KEY"])
	})

	t.Run("maps default publishable to SUPABASE_PUBLISHABLE_KEY alongside custom names", func(t *testing.T) {
		envs := ToEnv([]api.ApiKeyResponse{{
			Name:   "mobile",
			Type:   nullable.NewNullableWithValue(api.ApiKeyResponseTypePublishable),
			ApiKey: nullable.NewNullableWithValue("sb_publishable_mobile"),
		}, {
			Name:   "default",
			Type:   nullable.NewNullableWithValue(api.ApiKeyResponseTypePublishable),
			ApiKey: nullable.NewNullableWithValue("sb_publishable_default"),
		}})
		assert.Equal(t, map[string]string{
			"SUPABASE_MOBILE_KEY":      "sb_publishable_mobile",
			"SUPABASE_PUBLISHABLE_KEY": "sb_publishable_default",
		}, envs)
	})

	t.Run("masks null publishable api key", func(t *testing.T) {
		envs := ToEnv([]api.ApiKeyResponse{{
			Name:   "default",
			Type:   nullable.NewNullableWithValue(api.ApiKeyResponseTypePublishable),
			ApiKey: nullable.NewNullNullable[string](),
		}})
		assert.Equal(t, "******", envs["SUPABASE_PUBLISHABLE_KEY"])
	})
}
