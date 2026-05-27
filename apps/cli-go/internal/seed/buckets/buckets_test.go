package buckets

import (
	"context"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/storage"
)

func TestSeedBuckets(t *testing.T) {
	t.Run("seeds buckets", func(t *testing.T) {
		t.Cleanup(func() { clear(utils.Config.Storage.Buckets) })
		config := `
[test]
public = true
[private]
public = false`
		require.NoError(t, toml.Unmarshal([]byte(config), &utils.Config.Storage.Buckets))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		bucketPath := filepath.Join(utils.SupabaseDirPath, "images")
		require.NoError(t, fsys.Mkdir(bucketPath, 0755))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{{
				Name: "test",
				Id:   "test",
			}})
		gock.New(utils.Config.Api.ExternalUrl).
			Put("/storage/v1/bucket/test").
			Reply(http.StatusOK).
			JSON(storage.UpdateBucketResponse{})
		gock.New(utils.Config.Api.ExternalUrl).
			Post("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON(storage.CreateBucketResponse{Name: "private"})
		// Run test
		err := Run(context.Background(), "", false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("ignores unconfigured buckets", func(t *testing.T) {
		t.Cleanup(func() {
			utils.Config.Storage.TargetMigration = ""
			gock.OffAll()
		})
		utils.Config.Storage.TargetMigration = "custom-metadata"
		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusBadRequest).
			JSON(map[string]string{
				"statusCode": "403",
				"error":      "Unauthorized",
				"message":    "new row violates row-level security policy",
			})
		// Run test
		err := Run(context.Background(), "", false, afero.NewMemMapFs())
		// Check error
		assert.NoError(t, err)
		assert.Len(t, gock.Pending(), 1)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("seeds vector buckets locally", func(t *testing.T) {
		t.Cleanup(func() {
			utils.Config.Storage.VectorBuckets.Enabled = false
			clear(utils.Config.Storage.VectorBuckets.Buckets)
			gock.OffAll()
		})
		utils.Config.Storage.VectorBuckets.Enabled = true
		utils.Config.Storage.VectorBuckets.Buckets = map[string]struct{}{
			"documents-openai": {},
			"existing-vec":     {},
		}
		// Setup mock api: regular buckets list is empty, vector list has one
		// configured bucket plus one stale bucket that should be left alone
		// because non-interactive prune defaults to false.
		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		gock.New(utils.Config.Api.ExternalUrl).
			Post("/storage/v1/vector/ListVectorBuckets").
			Reply(http.StatusOK).
			JSON(storage.ListVectorBucketsResponse{
				VectorBuckets: []storage.VectorBucket{
					{VectorBucketName: "existing-vec"},
					{VectorBucketName: "stale-vec"},
				},
			})
		gock.New(utils.Config.Api.ExternalUrl).
			Post("/storage/v1/vector/CreateVectorBucket").
			Reply(http.StatusOK).
			JSON(map[string]string{})
		gock.New(utils.Config.Api.ExternalUrl).
			Post("/storage/v1/vector/DeleteVectorBucket").
			Reply(http.StatusOK).
			JSON(map[string]string{})
		// Run test
		err := Run(context.Background(), "", false, afero.NewMemMapFs())
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// The DeleteVectorBucket mock should remain pending because non-interactive
		// prune returns the default (false) and skips the delete.
		pending := gock.Pending()
		require.Len(t, pending, 1)
		assert.Contains(t, pending[0].Request().URLStruct.Path, "DeleteVectorBucket")
	})
}
