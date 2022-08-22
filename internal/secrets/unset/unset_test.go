package unset

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

func TestSecretUnsetCommand(t *testing.T) {
	t.Run("Unsets secret via cli args", func(t *testing.T) {
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
		gock.New("https://api.supabase.io").
			Delete("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.DeleteSecretsJSONBody{"my-secret"}).
			Reply(200)
		// Run test
		assert.NoError(t, Run(context.Background(), []string{"my-secret"}, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing config file", func(t *testing.T) {
		assert.Error(t, Run(context.Background(), []string{}, afero.NewMemMapFs()))
	})

	t.Run("throws error on missing project ref", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Run test
		assert.Error(t, Run(context.Background(), []string{}, fsys))
	})

	t.Run("throws error on missing access token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		_, err = fsys.Create(utils.ProjectRefPath)
		require.NoError(t, err)
		// Run test
		assert.Error(t, Run(context.Background(), []string{}, fsys))
	})

	t.Run("throws error on empty secret", func(t *testing.T) {
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
		// Run test
		assert.Error(t, Run(context.Background(), []string{}, fsys))
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
		gock.New("https://api.supabase.io").
			Delete("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.DeleteSecretsJSONBody{"my-secret"}).
			ReplyError(errors.New("network error"))
		// Run test
		assert.Error(t, Run(context.Background(), []string{"my-secret"}, fsys))
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
		gock.New("https://api.supabase.io").
			Delete("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.DeleteSecretsJSONBody{"my-secret"}).
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		assert.Error(t, Run(context.Background(), []string{"my-secret"}, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
