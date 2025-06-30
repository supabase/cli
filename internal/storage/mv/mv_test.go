package mv

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/oapi-codegen/nullable"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
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

func TestStorageMV(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	apiKeys := []api.ApiKeyResponse{{
		Name:   "service_role",
		ApiKey: nullable.NewNullableWithValue("service-key"),
	}}

	t.Run("moves single object", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Post("/storage/v1/object/move").
			JSON(storage.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "readme.md",
				DestinationKey: "docs/file",
			}).
			Reply(http.StatusOK).
			JSON(storage.MoveObjectResponse{Message: "Successfully moved"})
		// Run test
		err := Run(context.Background(), "ss:///private/readme.md", "ss:///private/docs/file", false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("moves directory when recursive", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Post("/storage/v1/object/move").
			JSON(storage.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "",
				DestinationKey: "docs",
			}).
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "not_found"})
		// List bucket /private/
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{mockFile})
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Post("/storage/v1/object/move").
			JSON(storage.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "abstract.pdf",
				DestinationKey: "docs/abstract.pdf",
			}).
			Reply(http.StatusOK).
			JSON(storage.MoveObjectResponse{Message: "Successfully moved"})
		// Run test
		err := Run(context.Background(), "ss:///private", "ss:///private/docs", true, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on invalid src", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), ":", "ss:///", false, fsys)
		// Check error
		assert.ErrorContains(t, err, "missing protocol scheme")
	})

	t.Run("throws error on invalid dst", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "ss:///", ":", false, fsys)
		// Check error
		assert.ErrorContains(t, err, "missing protocol scheme")
	})

	t.Run("throws error on missing object path", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "ss:///", "ss:///", false, fsys)
		// Check error
		assert.ErrorIs(t, err, errMissingPath)
	})

	t.Run("throws error on bucket mismatch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "ss:///bucket/docs", "ss:///private", false, fsys)
		// Check error
		assert.ErrorIs(t, err, errUnsupportedMove)
	})
}

func TestMoveAll(t *testing.T) {
	t.Run("rename directory within bucket", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		// Lists /private/tmp directory
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
			}, mockFile})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/move").
			JSON(storage.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "tmp/abstract.pdf",
				DestinationKey: "dir/abstract.pdf",
			}).
			Reply(http.StatusOK).
			JSON(storage.MoveObjectResponse{Message: "Successfully moved"})
		// Lists /private/tmp/docs directory
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
			JSON([]storage.ObjectResponse{readme})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/move").
			JSON(storage.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "tmp/docs/readme.md",
				DestinationKey: "dir/docs/readme.md",
			}).
			Reply(http.StatusOK).
			JSON(storage.MoveObjectResponse{Message: "Successfully moved"})
		// Run test
		err := MoveStorageObjectAll(context.Background(), mockApi, "private/tmp/", "private/dir")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("moves object into directory", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		// Lists /private/ bucket
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			JSON(storage.ListObjectsQuery{
				Prefix: "",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{mockFile})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/move").
			JSON(storage.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "abstract.pdf",
				DestinationKey: "dir/abstract.pdf",
			}).
			Reply(http.StatusOK).
			JSON(storage.MoveObjectResponse{Message: "Successfully moved"})
		// Run test
		err := MoveStorageObjectAll(context.Background(), mockApi, "private/", "private/dir")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("moves object out of directory", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		// Lists /private/tmp/ directory
		readme := mockFile
		readme.Name = "readme.md"
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			JSON(storage.ListObjectsQuery{
				Prefix: "tmp/",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{readme})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/move").
			JSON(storage.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "tmp/readme.md",
				DestinationKey: "readme.md",
			}).
			Reply(http.StatusOK).
			JSON(storage.MoveObjectResponse{Message: "Successfully moved"})
		// Run test
		err := MoveStorageObjectAll(context.Background(), mockApi, "private/tmp/", "private")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := MoveStorageObjectAll(context.Background(), mockApi, "private/tmp/", "private")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on move failure", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{mockFile})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/move").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := MoveStorageObjectAll(context.Background(), mockApi, "private/tmp/", "private")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing object", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		// Run test
		err := MoveStorageObjectAll(context.Background(), mockApi, "private/tmp/", "private")
		// Check error
		assert.ErrorContains(t, err, "Object not found: private/tmp/")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
