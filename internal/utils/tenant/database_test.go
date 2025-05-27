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
	t.Run("retrieves database version successfully", func(t *testing.T) {
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		defer gock.OffAll()
		projectRef := apitest.RandomProjectRef()
		mockPostgres := api.V1ProjectWithDatabaseResponse{Id: projectRef}
		mockPostgres.Database.Version = "14.1.0.99"
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(http.StatusOK).
			JSON([]api.V1ProjectWithDatabaseResponse{mockPostgres})

		version, err := GetDatabaseVersion(context.Background(), projectRef)

		assert.NoError(t, err)
		assert.Equal(t, "14.1.0.99", version)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles project not found", func(t *testing.T) {
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		defer gock.OffAll()
		projectRef := apitest.RandomProjectRef()
		mockPostgres := api.V1ProjectWithDatabaseResponse{Id: "different-project"}
		mockPostgres.Database.Version = "14.1.0.99"
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(http.StatusOK).
			JSON([]api.V1ProjectWithDatabaseResponse{mockPostgres})

		version, err := GetDatabaseVersion(context.Background(), projectRef)

		assert.ErrorIs(t, err, errDatabaseVersion)
		assert.Empty(t, version)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles empty database version", func(t *testing.T) {
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		defer gock.OffAll()
		projectRef := apitest.RandomProjectRef()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(http.StatusOK).
			JSON([]api.V1ProjectWithDatabaseResponse{{
				Id: projectRef,
			}})

		version, err := GetDatabaseVersion(context.Background(), projectRef)

		assert.ErrorIs(t, err, errDatabaseVersion)
		assert.Empty(t, version)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
