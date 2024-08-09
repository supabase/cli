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
		// Setup mock api
		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		// Run test
		err := Run(context.Background(), "", false, afero.NewMemMapFs())
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
