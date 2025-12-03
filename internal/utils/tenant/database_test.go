package tenant

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestGetDatabaseVersion(t *testing.T) {
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	// Setup valid project ref
	projectRef := apitest.RandomProjectRef()

	t.Run("retrieves database version successfully", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		mockPostgres := api.V1ProjectWithDatabaseResponse{}
		mockPostgres.Database.Version = "14.1.0.99"
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef).
			Reply(http.StatusOK).
			JSON(mockPostgres)
		// Run test
		version, err := GetDatabaseVersion(context.Background(), projectRef)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "14.1.0.99", version)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles project not found", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		projectRef := apitest.RandomProjectRef()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef).
			Reply(http.StatusNotFound)
		// Run test
		version, err := GetDatabaseVersion(context.Background(), projectRef)
		// Check error
		assert.ErrorContains(t, err, "unexpected retrieve project status 404:")
		assert.Empty(t, version)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles empty database version", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		projectRef := apitest.RandomProjectRef()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef).
			Reply(http.StatusOK).
			JSON(api.V1ProjectWithDatabaseResponse{})
		// Run test
		version, err := GetDatabaseVersion(context.Background(), projectRef)
		// Check error
		assert.ErrorIs(t, err, errDatabaseVersion)
		assert.Empty(t, version)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
