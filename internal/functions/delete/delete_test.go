package delete

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestDeleteCommand(t *testing.T) {
	const slug = "test-func"
	t.Run("deletes function from project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK)
		// Run test
		assert.NoError(t, Run(context.Background(), slug, project, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		err := Run(context.Background(), "@", project, fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid Function name.")
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + project + "/functions/" + slug).
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), slug, project, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing function", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound).
			JSON(map[string]string{"message": "Function not found"})
		// Run test
		err := Run(context.Background(), slug, project, fsys)
		// Check error
		assert.ErrorContains(t, err, "Function test-func does not exist on the Supabase project.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), slug, project, fsys)
		// Check error
		assert.ErrorContains(t, err, "Failed to delete Function test-func on the Supabase project:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
