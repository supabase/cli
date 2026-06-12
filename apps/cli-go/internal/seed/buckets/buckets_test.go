package buckets

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

	t.Run("does not call vector API when no vector buckets are configured", func(t *testing.T) {
		t.Cleanup(func() {
			clear(utils.Config.Storage.Buckets)
			utils.Config.Storage.VectorBuckets.Enabled = false
			clear(utils.Config.Storage.VectorBuckets.Buckets)
			gock.OffAll()
		})
		config := `
[images]
public = true`
		require.NoError(t, toml.Unmarshal([]byte(config), &utils.Config.Storage.Buckets))
		utils.Config.Storage.VectorBuckets.Enabled = true
		utils.Config.Storage.VectorBuckets.Buckets = map[string]struct{}{}

		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		gock.New(utils.Config.Api.ExternalUrl).
			Post("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON(storage.CreateBucketResponse{Name: "images"})

		err := Run(context.Background(), "", false, afero.NewMemMapFs())

		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("does not call storage API when no buckets are configured", func(t *testing.T) {
		t.Cleanup(func() {
			utils.Config.Storage.VectorBuckets.Enabled = false
			clear(utils.Config.Storage.VectorBuckets.Buckets)
			gock.OffAll()
		})
		utils.Config.Storage.VectorBuckets.Enabled = true
		utils.Config.Storage.VectorBuckets.Buckets = map[string]struct{}{}

		err := Run(context.Background(), "", false, afero.NewMemMapFs())

		assert.NoError(t, err)
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

	t.Run("warns and continues when vector buckets are unavailable in the region", func(t *testing.T) {
		t.Cleanup(func() {
			utils.Config.Storage.VectorBuckets.Enabled = false
			clear(utils.Config.Storage.VectorBuckets.Buckets)
			gock.OffAll()
		})
		utils.Config.Storage.VectorBuckets.Enabled = true
		utils.Config.Storage.VectorBuckets.Buckets = map[string]struct{}{
			"documents-openai": {},
		}

		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		gock.New(utils.Config.Api.ExternalUrl).
			Post("/storage/v1/vector/ListVectorBuckets").
			Reply(http.StatusBadRequest).
			JSON(map[string]string{
				"code":    "FeatureNotEnabled",
				"message": "Feature is not enabled",
			})

		stderr := captureStderr(t, func() {
			err := Run(context.Background(), "", false, afero.NewMemMapFs())
			assert.NoError(t, err)
		})

		assert.Contains(t, stderr, "WARNING:")
		assert.Contains(t, stderr, "Vector buckets are not available in this project's region yet")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("warns and continues when local vector storage is not configured", func(t *testing.T) {
		t.Cleanup(func() {
			utils.Config.Storage.VectorBuckets.Enabled = false
			clear(utils.Config.Storage.VectorBuckets.Buckets)
			gock.OffAll()
		})
		utils.Config.Storage.VectorBuckets.Enabled = true
		utils.Config.Storage.VectorBuckets.Buckets = map[string]struct{}{
			"documents-openai": {},
		}

		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		gock.New(utils.Config.Api.ExternalUrl).
			Post("/storage/v1/vector/ListVectorBuckets").
			Reply(http.StatusConflict).
			JSON(map[string]any{
				"statusCode": http.StatusConflict,
				"code":       "InvalidRequest",
				"error":      "InvalidRequest",
				"message":    "The feature Vector service not configured is not enabled for this resource",
			})

		stderr := captureStderr(t, func() {
			err := Run(context.Background(), "", false, afero.NewMemMapFs())
			assert.NoError(t, err)
		})

		assert.Contains(t, stderr, "WARNING:")
		assert.Contains(t, stderr, "Vector buckets are not available in the local storage service")
		assert.Contains(t, stderr, "supabase link")
		assert.Contains(t, stderr, "restart the local stack")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("warns and continues when local vector routes are not registered", func(t *testing.T) {
		t.Cleanup(func() {
			utils.Config.Storage.VectorBuckets.Enabled = false
			clear(utils.Config.Storage.VectorBuckets.Buckets)
			gock.OffAll()
		})
		utils.Config.Storage.VectorBuckets.Enabled = true
		utils.Config.Storage.VectorBuckets.Buckets = map[string]struct{}{
			"documents-openai": {},
		}

		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		gock.New(utils.Config.Api.ExternalUrl).
			Post("/storage/v1/vector/ListVectorBuckets").
			Reply(http.StatusNotFound).
			JSON(map[string]any{
				"statusCode": http.StatusNotFound,
				"error":      "Not Found",
				"message":    "Route POST:/vector/ListVectorBuckets not found",
			})

		stderr := captureStderr(t, func() {
			err := Run(context.Background(), "", false, afero.NewMemMapFs())
			assert.NoError(t, err)
		})

		assert.Contains(t, stderr, "WARNING:")
		assert.Contains(t, stderr, "Vector buckets are not available in the local storage service")
		assert.Contains(t, stderr, "supabase link")
		assert.Contains(t, stderr, "restart the local stack")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func captureStderr(t *testing.T, run func()) string {
	t.Helper()
	reader, writer, err := os.Pipe()
	require.NoError(t, err)
	original := os.Stderr
	os.Stderr = writer
	t.Cleanup(func() {
		os.Stderr = original
		reader.Close()
	})

	run()

	require.NoError(t, writer.Close())
	os.Stderr = original
	out, err := io.ReadAll(reader)
	require.NoError(t, err)
	return strings.TrimSpace(string(out))
}
