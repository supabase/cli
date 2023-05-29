package delete

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/zalando/go-keyring"
	"gopkg.in/h2non/gock.v1"
)

func TestDeleteCommand(t *testing.T) {
	const ref = "test-project"
	// Mock credentials store
	keyring.MockInit()

	t.Run("deletes project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(ref), 0644))
		// Setup api mock
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + ref + "").
			Reply(http.StatusOK).
			JSON(api.ProjectRefResponse{Ref: ref})
		// Run test
		err := Run(context.Background(), ref, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup api mock
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + ref + "").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), ref, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on project not found", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup api mock
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + ref + "").
			Reply(http.StatusNotFound)
		// Run test
		err := Run(context.Background(), ref, fsys)
		// Check error
		assert.ErrorContains(t, err, "Project test-project does not exist.")
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup api mock
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + ref + "").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), ref, fsys)
		// Check error
		assert.ErrorContains(t, err, "Failed to delete project test-project:")
	})
}
