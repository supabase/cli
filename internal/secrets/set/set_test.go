package set

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestSecretSetCommand(t *testing.T) {
	dummy := api.CreateSecretBody{Name: "my_name", Value: "my_value"}
	dummyEnv := dummy.Name + "=" + dummy.Value

	t.Run("Sets secret via cli args", func(t *testing.T) {
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
			Post("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.CreateSecretsJSONBody{dummy}).
			Reply(200)
		// Run test
		err := Run(context.Background(), project, "", []string{dummyEnv}, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("Sets secret value via env file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup dotenv file
		tmpfile, err := os.CreateTemp("", "secret")
		require.NoError(t, err)
		defer os.Remove(tmpfile.Name())
		_, err = tmpfile.Write([]byte(dummyEnv))
		require.NoError(t, err)
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.CreateSecretsJSONBody{dummy}).
			Reply(200)
		// Run test
		err = Run(context.Background(), project, tmpfile.Name(), []string{}, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on empty secret", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Run test
		err := Run(context.Background(), project, "", []string{}, fsys)
		// Check error
		assert.ErrorContains(t, err, "No arguments found. Use --env-file to read from a .env file.")
	})

	t.Run("throws error on malformed secret", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Run test
		err := Run(context.Background(), project, "", []string{"malformed"}, fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid secret pair: malformed. Must be NAME=VALUE.")
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
			Post("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.CreateSecretsJSONBody{dummy}).
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), project, "", []string{dummyEnv}, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
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
			Post("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.CreateSecretsJSONBody{dummy}).
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		err := Run(context.Background(), project, "", []string{dummyEnv}, fsys)
		// Check error
		assert.ErrorContains(t, err, `Unexpected error setting project secrets: {"message":"unavailable"}`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
