package get

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestGetRootKey(t *testing.T) {
	t.Run("fetches project encryption key", func(t *testing.T) {
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/pgsodium").
			Reply(http.StatusOK).
			JSON(api.PgsodiumConfigResponse{RootKey: "test-key"})
		// Run test
		err := Run(context.Background(), project)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws on invalid credentials", func(t *testing.T) {
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/pgsodium").
			Reply(http.StatusForbidden)
		// Run test
		err := Run(context.Background(), project)
		// Check error
		assert.ErrorContains(t, err, "Unexpected error retrieving project root key:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
