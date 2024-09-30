package unpause

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
	"github.com/zalando/go-keyring"
)

func TestUnpauseCommand(t *testing.T) {
	ref := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	// Mock credentials store
	keyring.MockInit()

	t.Run("unpause project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(ref), 0644))
		// Setup api mock
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + ref + "/unpause").
			Reply(http.StatusCreated).
			JSON(api.V1UnpauseAProjectResponse{})
		// Run test
		err := Run(context.Background(), ref)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		// Setup api mock
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + ref + "/unpause").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), ref)
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on project not found", func(t *testing.T) {
		// Setup api mock
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + ref + "/unpause").
			Reply(http.StatusNotFound)
		// Run test
		err := Run(context.Background(), ref)
		// Check error
		assert.ErrorContains(t, err, "Project does not exist:")
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup api mock
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + ref + "/unpause").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), ref)
		// Check error
		assert.ErrorContains(t, err, "Failed to unpause project")
	})
}
