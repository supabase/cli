package apiKeys

import (
	"context"
	"errors"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestProjectApiKeysCommand(t *testing.T) {
	t.Run("lists all api-keys", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{
				Name:   "Test ApiKey",
				ApiKey: "dummy-api-key-value",
			}})
		// Run test
		err := Run(context.Background(), project, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing access token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Unexpected error retrieving project api-keys")
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
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
}
