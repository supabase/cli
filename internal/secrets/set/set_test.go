package set

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestSecretSetCommand(t *testing.T) {
	dummy := api.CreateSecretBody{{Name: "my_name", Value: "my_value"}}
	dummyEnv := dummy[0].Name + "=" + dummy[0].Value
	utils.CurrentDirAbs = "/tmp"

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
			JSON(dummy).
			Reply(http.StatusCreated)
		// Run test
		err := Run(context.Background(), project, "", []string{dummyEnv}, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("Sets secret value via env file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, "/tmp/.env", []byte(dummyEnv), 0644))
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
			JSON(dummy).
			Reply(http.StatusCreated)
		// Run test
		err := Run(context.Background(), project, "/tmp/.env", []string{}, fsys)
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

	t.Run("throws error on bare name in non-interactive mode", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Run test
		err := Run(context.Background(), project, "", []string{"MY_SECRET"}, fsys)
		// Check error - non-TTY test environment triggers the non-interactive guard
		assert.ErrorContains(t, err, "Cannot prompt for secret value in non-interactive mode")
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
			JSON(dummy).
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
			JSON(dummy).
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		err := Run(context.Background(), project, "", []string{dummyEnv}, fsys)
		// Check error
		assert.ErrorContains(t, err, `Unexpected error setting project secrets: {"message":"unavailable"}`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestListSecrets(t *testing.T) {
	fsys := afero.NewMemMapFs()

	t.Run("errors on bare name with nil prompter", func(t *testing.T) {
		_, err := ListSecrets("", fsys, nil, "malformed")
		assert.ErrorContains(t, err, "Invalid secret pair: malformed. Must be NAME=VALUE.")
	})

	t.Run("prompts for secret value interactively", func(t *testing.T) {
		mockPrompt := func(name string) (string, error) {
			assert.Equal(t, "MY_SECRET", name)
			return "prompted_value", nil
		}
		secrets, err := ListSecrets("", fsys, mockPrompt, "MY_SECRET")
		require.NoError(t, err)
		require.Len(t, secrets, 1)
		assert.Equal(t, "MY_SECRET", secrets[0].Name)
		assert.Equal(t, "prompted_value", secrets[0].Value)
	})

	t.Run("prompts for multiple secrets", func(t *testing.T) {
		callCount := 0
		mockPrompt := func(name string) (string, error) {
			callCount++
			return "value_" + name, nil
		}
		secrets, err := ListSecrets("", fsys, mockPrompt, "KEY1", "KEY2")
		require.NoError(t, err)
		assert.Equal(t, 2, callCount)
		assert.Len(t, secrets, 2)
	})

	t.Run("mixes inline and prompted secrets", func(t *testing.T) {
		mockPrompt := func(name string) (string, error) {
			assert.Equal(t, "KEY2", name)
			return "prompted_value", nil
		}
		secrets, err := ListSecrets("", fsys, mockPrompt, "KEY1=inline_value", "KEY2")
		require.NoError(t, err)
		assert.Len(t, secrets, 2)
		// Verify both secrets are present
		values := map[string]string{}
		for _, s := range secrets {
			values[s.Name] = s.Value
		}
		assert.Equal(t, "inline_value", values["KEY1"])
		assert.Equal(t, "prompted_value", values["KEY2"])
	})

	t.Run("propagates prompt error", func(t *testing.T) {
		mockPrompt := func(name string) (string, error) {
			return "", errors.New("prompt failed")
		}
		_, err := ListSecrets("", fsys, mockPrompt, "MY_SECRET")
		assert.ErrorContains(t, err, "prompt failed")
	})

	t.Run("skips SUPABASE_ prefixed bare name without prompting", func(t *testing.T) {
		mockPrompt := func(name string) (string, error) {
			t.Fatal("should not prompt for SUPABASE_ prefixed names")
			return "", nil
		}
		secrets, err := ListSecrets("", fsys, mockPrompt, "SUPABASE_FOO")
		require.NoError(t, err)
		assert.Empty(t, secrets)
	})
}
