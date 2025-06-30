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
