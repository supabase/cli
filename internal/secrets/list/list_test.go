package list

import (
	"context"
	"errors"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestSecretListCommand(t *testing.T) {
	t.Run("lists all secrets", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		err = afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644)
		require.NoError(t, err)
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/secrets").
			Reply(200).
			JSON(api.CreateSecretsJSONBody{
				{
					Name:  "Test Secret",
					Value: "dummy-secret-value",
				},
			})
		// Run test
		assert.NoError(t, Run(context.Background(), fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing config file", func(t *testing.T) {
		assert.Error(t, Run(context.Background(), afero.NewMemMapFs()))
	})

	t.Run("throws error on missing project ref", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Run test
		assert.Error(t, Run(context.Background(), fsys))
	})

	t.Run("throws error on missing access token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		_, err = fsys.Create(utils.ProjectRefPath)
		require.NoError(t, err)
		// Run test
		assert.Error(t, Run(context.Background(), fsys))
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		err = afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644)
		require.NoError(t, err)
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/secrets").
			ReplyError(errors.New("network error"))
		// Run test
		assert.Error(t, Run(context.Background(), fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		err = afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644)
		require.NoError(t, err)
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/secrets").
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		assert.Error(t, Run(context.Background(), fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed json", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		err = afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644)
		require.NoError(t, err)
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/secrets").
			Reply(200).
			JSON(map[string]string{})
		// Run test
		assert.Error(t, Run(context.Background(), fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
