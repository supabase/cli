package rm

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/oapi-codegen/nullable"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/fetcher"
	"github.com/supabase/cli/pkg/storage"
)

var mockFile = storage.ObjectResponse{
	Name:           "abstract.pdf",
	Id:             cast.Ptr("9b7f9f48-17a6-4ca8-b14a-39b0205a63e9"),
	UpdatedAt:      cast.Ptr("2023-10-13T18:08:22.068Z"),
	CreatedAt:      cast.Ptr("2023-10-13T18:08:22.068Z"),
	LastAccessedAt: cast.Ptr("2023-10-13T18:08:22.068Z"),
	Metadata: &storage.ObjectMetadata{
		ETag:           `"887ea9be3c68e6f2fca7fd2d7c77d8fe"`,
		Size:           82702,
		Mimetype:       "application/pdf",
		CacheControl:   "max-age=3600",
		LastModified:   "2023-10-13T18:08:22.000Z",
		ContentLength:  82702,
		HttpStatusCode: 200,
	},
}

var mockApi = storage.StorageAPI{Fetcher: fetcher.NewFetcher(
	"http://127.0.0.1",
)}

func TestStorageRM(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	apiKeys := []api.ApiKeyResponse{{
		Name:   "service_role",
		ApiKey: nullable.NewNullableWithValue("service-key"),
	}}

	t.Run("throws error on invalid url", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), []string{":"}, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "missing protocol scheme")
	})

	t.Run("throws error on missing bucket", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), []string{"ss:///"}, false, fsys)
		// Check error
		assert.ErrorIs(t, err, errMissingBucket)
	})

	t.Run("throws error on missing flag", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), []string{"ss:///private/"}, false, fsys)
		// Check error
		assert.ErrorIs(t, err, errMissingFlag)
	})

	t.Run("removes multiple objects", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Delete("/storage/v1/object/private").
			JSON(storage.DeleteObjectsRequest{Prefixes: []string{
				"abstract.pdf",
				"docs/readme.md",
			}}).
			Reply(http.StatusOK).
			JSON([]storage.DeleteObjectsResponse{{
				BucketId:       "private",
				Version:        "cf5c5c53-ee73-4806-84e3-7d92c954b436",
				Name:           "abstract.pdf",
				Id:             "9b7f9f48-17a6-4ca8-b14a-39b0205a63e9",
				UpdatedAt:      "2023-10-13T18:08:22.068Z",
				CreatedAt:      "2023-10-13T18:08:22.068Z",
				LastAccessedAt: "2023-10-13T18:08:22.068Z",
			}})
		// Run test
		err := Run(context.Background(), []string{
			"ss:///private/abstract.pdf",
			"ss:///private/docs/readme.md",
		}, false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("removes buckets and directories", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		// Delete /test/ bucket
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Post("/storage/v1/object/list/test").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Delete("/storage/v1/object/test").
			JSON(storage.DeleteObjectsRequest{Prefixes: []string{
				"",
			}}).
			Reply(http.StatusOK).
			JSON([]storage.DeleteObjectsResponse{})
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Post("/storage/v1/object/list/test").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Delete("/storage/v1/bucket/test").
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "Bucket not found"})
		// Delete /private/docs/ directory
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Delete("/storage/v1/object/private").
			JSON(storage.DeleteObjectsRequest{Prefixes: []string{
				"docs",
			}}).
			Reply(http.StatusOK).
			JSON([]storage.DeleteObjectsResponse{})
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{mockFile})
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Delete("/storage/v1/object/private").
			JSON(storage.DeleteObjectsRequest{Prefixes: []string{
				"docs/abstract.pdf",
			}}).
			Reply(http.StatusOK).
			JSON([]storage.DeleteObjectsResponse{{
				BucketId:       "private",
				Version:        "cf5c5c53-ee73-4806-84e3-7d92c954b436",
				Name:           "abstract.pdf",
				Id:             "9b7f9f48-17a6-4ca8-b14a-39b0205a63e9",
				UpdatedAt:      "2023-10-13T18:08:22.068Z",
				CreatedAt:      "2023-10-13T18:08:22.068Z",
				LastAccessedAt: "2023-10-13T18:08:22.068Z",
			}})
		// Run test
		err := Run(context.Background(), []string{
			"ss:///test",
			"ss:///private/docs",
		}, true, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on delete failure", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Delete("/storage/v1/object/private").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), []string{"ss:///private"}, true, fsys)
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestRemoveAll(t *testing.T) {
	t.Run("removes objects by prefix", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		// List /private/tmp/
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			JSON(storage.ListObjectsQuery{
				Prefix: "tmp/",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{{
				Name: "docs",
			}})
		// List /private/docs/
		readme := mockFile
		readme.Name = "readme.md"
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			JSON(storage.ListObjectsQuery{
				Prefix: "tmp/docs/",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{mockFile, readme})
		gock.New("http://127.0.0.1").
			Delete("/storage/v1/object/private").
			JSON(storage.DeleteObjectsRequest{Prefixes: []string{
				"tmp/docs/abstract.pdf",
				"tmp/docs/readme.md",
			}}).
			Reply(http.StatusOK).
			JSON([]storage.DeleteObjectsResponse{{
				BucketId:       "private",
				Version:        "cf5c5c53-ee73-4806-84e3-7d92c954b436",
				Name:           "abstract.pdf",
				Id:             "9b7f9f48-17a6-4ca8-b14a-39b0205a63e9",
				UpdatedAt:      "2023-10-13T18:08:22.068Z",
				CreatedAt:      "2023-10-13T18:08:22.068Z",
				LastAccessedAt: "2023-10-13T18:08:22.068Z",
			}, {
				BucketId:       "private",
				Version:        "cf5c5c53-ee73-4806-84e3-7d92c954b436",
				Name:           "readme.md",
				Id:             "9b7f9f48-17a6-4ca8-b14a-39b0205a63e9",
				UpdatedAt:      "2023-10-13T18:08:22.068Z",
				CreatedAt:      "2023-10-13T18:08:22.068Z",
				LastAccessedAt: "2023-10-13T18:08:22.068Z",
			}})
		// Run test
		err := RemoveStoragePathAll(context.Background(), mockApi, "private", "tmp/")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("removes empty bucket", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		gock.New("http://127.0.0.1").
			Delete("/storage/v1/bucket/private").
			Reply(http.StatusOK).
			JSON(storage.DeleteBucketResponse{Message: "Successfully deleted"})
		// Run test
		err := RemoveStoragePathAll(context.Background(), mockApi, "private", "")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on empty directory", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		// Run test
		err := RemoveStoragePathAll(context.Background(), mockApi, "private", "dir")
		// Check error
		assert.ErrorContains(t, err, "Object not found: private/dir")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := RemoveStoragePathAll(context.Background(), mockApi, "private", "")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on delete failure", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{mockFile})
		gock.New("http://127.0.0.1").
			Delete("/storage/v1/object/private").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := RemoveStoragePathAll(context.Background(), mockApi, "private", "")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
