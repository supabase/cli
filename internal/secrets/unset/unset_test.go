package unset

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

func TestSecretUnsetCommand(t *testing.T) {
	t.Run("Unsets secret via cli args", func(t *testing.T) {
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
			Delete("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.DeleteSecretsJSONBody{"my-secret"}).
			Reply(200)
		// Run test
		err := Run(context.Background(), project, []string{"my-secret"}, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
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
			Delete("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.DeleteSecretsJSONBody{"my-secret"}).
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), project, []string{"my-secret"}, fsys)
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
			Delete("/v1/projects/" + project + "/secrets").
			MatchType("json").
			JSON(api.DeleteSecretsJSONBody{"my-secret"}).
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		err := Run(context.Background(), project, []string{"my-secret"}, fsys)
		// Check error
		assert.ErrorContains(t, err, `Unexpected error unsetting project secrets: {"message":"unavailable"}`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
