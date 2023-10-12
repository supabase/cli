package update

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestUpdateRootKey(t *testing.T) {
	t.Run("updates project encryption key", func(t *testing.T) {
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup root key
		r, w, err := os.Pipe()
		require.NoError(t, err)
		_, err = w.WriteString("test-key")
		require.NoError(t, err)
		require.NoError(t, w.Close())
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + project + "/pgsodium").
			JSON(api.UpdatePgsodiumConfigBody{RootKey: "test-key"}).
			Reply(http.StatusOK).
			JSON(api.PgsodiumConfigResponse{RootKey: "test-key"})
		// Run test
		err = Run(context.Background(), project, r)
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
			Put("/v1/projects/" + project + "/pgsodium").
			Reply(http.StatusForbidden)
		// Run test
		err := Run(context.Background(), project, nil)
		// Check error
		assert.ErrorContains(t, err, "Unexpected error updating project root key:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
