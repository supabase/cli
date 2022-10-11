package delete

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestDeleteCommand(t *testing.T) {
	t.Run("deletes function from project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/test-func").
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New("https://api.supabase.io").
			Delete("/v1/projects/" + project + "/functions/test-func").
			Reply(http.StatusOK)
		// Run test
		assert.NoError(t, Run(context.Background(), "test-func", "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed ref", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup invalid project ref
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte("test-project"), 0644))
		// Run test
		err := Run(context.Background(), "test-func", "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid project ref format.")
	})

	t.Run("throws error on malformed ref arg", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "test-func", "test-project", fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid project ref format.")
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
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/test-func").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), "test-func", project, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/test-func").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), "test-func", project, fsys)
		// Check error
		assert.ErrorContains(t, err, "Unexpected error deleting Function:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing function", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/test-func").
			Reply(http.StatusNotFound)
		// Run test
		err := Run(context.Background(), "test-func", project, fsys)
		// Check error
		assert.ErrorContains(t, err, "Function test-func does not exist on the Supabase project.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on delete failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/test-func").
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New("https://api.supabase.io").
			Delete("/v1/projects/" + project + "/functions/test-func").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), "test-func", project, fsys)
		// Check error
		assert.ErrorContains(t, err, "Failed to delete Function test-func on the Supabase project:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on delete network failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/test-func").
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New("https://api.supabase.io").
			Delete("/v1/projects/" + project + "/functions/test-func").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), "test-func", project, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
