package cp

import (
	"context"
	"io/fs"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/oapi-codegen/nullable"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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

func TestStorageCP(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	apiKeys := []api.ApiKeyResponse{{
		Name:   "service_role",
		ApiKey: nullable.NewNullableWithValue("service-key"),
	}}

	t.Run("copy local to remote", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, "/tmp/file", []byte{}, 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Post("/storage/v1/object/private/file").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), "/tmp/file", "ss:///private/file", false, 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		// Run test
		err := Run(context.Background(), "abstract.pdf", "ss:///private", true, 1, fsys)
		// Check error
		assert.ErrorIs(t, err, fs.ErrNotExist)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("copy remote to local", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Get("/storage/v1/object/private/file").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), "ss:///private/file", "abstract.pdf", false, 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		exists, err := afero.Exists(fsys, "abstract.pdf")
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("throws error on missing bucket", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		// Run test
		err := Run(context.Background(), "ss:///private", ".", true, 1, fsys)
		// Check error
		assert.ErrorContains(t, err, "Object not found: /private")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on invalid src", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), ":", ".", false, 1, fsys)
		// Check error
		assert.ErrorContains(t, err, "missing protocol scheme")
	})

	t.Run("throws error on invalid dst", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), ".", ":", false, 1, fsys)
		// Check error
		assert.ErrorContains(t, err, "missing protocol scheme")
	})

	t.Run("throws error on unsupported operation", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON(apiKeys)
		// Run test
		err := Run(context.Background(), ".", ".", false, 1, fsys)
		// Check error
		assert.ErrorIs(t, err, errUnsupportedOperation)
	})
}

func TestUploadAll(t *testing.T) {
	t.Run("uploads directory to new bucket", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, "/tmp/readme.md", []byte{}, 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/tmp/readme.md").
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "Bucket not found"})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON(storage.CreateBucketResponse{Name: "tmp"})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/tmp/readme.md").
			Reply(http.StatusOK)
		// Run test
		err := UploadStorageObjectAll(context.Background(), mockApi, "", "/tmp", 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to create bucket", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, "/tmp/readme.md", []byte{}, 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/tmp/readme.md").
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "Bucket not found"})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/bucket").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := UploadStorageObjectAll(context.Background(), mockApi, "", "/tmp", 1, fsys)
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("uploads directory to existing prefix", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, "/tmp/readme.md", []byte{}, 0644))
		require.NoError(t, afero.WriteFile(fsys, "/tmp/docs/api.md", []byte{}, 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{{
				Name: "dir",
			}})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/private/dir/tmp/readme.md").
			Reply(http.StatusOK)
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/private/dir/tmp/docs/api.md").
			Reply(http.StatusOK)
		// Run test
		err := UploadStorageObjectAll(context.Background(), mockApi, "/private/dir/", "/tmp", 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("uploads file to existing bucket", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, "/tmp/readme.md", []byte{}, 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{{
				Id:        "private",
				Name:      "private",
				CreatedAt: "2023-10-13T17:48:58.491Z",
				UpdatedAt: "2023-10-13T17:48:58.491Z",
			}})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/private/readme.md").
			Reply(http.StatusOK)
		// Run test
		err := UploadStorageObjectAll(context.Background(), mockApi, "private", "/tmp/readme.md", 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("uploads file to existing object", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, "/tmp/readme.md", []byte{}, 0644))
		// Setup mock api
		defer gock.OffAll()
		fileObject := mockFile
		fileObject.Name = "file"
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{fileObject})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/private/file").
			Reply(http.StatusOK)
		// Run test
		err := UploadStorageObjectAll(context.Background(), mockApi, "private/file", "/tmp/readme.md", 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/bucket").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := UploadStorageObjectAll(context.Background(), mockApi, "missing", ".", 1, fsys)
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestDownloadAll(t *testing.T) {
	t.Run("downloads buckets to existing directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{{
				Id:        "test",
				Name:      "test",
				Public:    true,
				CreatedAt: "2023-10-13T17:48:58.491Z",
				UpdatedAt: "2023-10-13T17:48:58.491Z",
			}, {
				Id:        "private",
				Name:      "private",
				CreatedAt: "2023-10-13T17:48:58.491Z",
				UpdatedAt: "2023-10-13T17:48:58.491Z",
			}})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/test").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		// Run test
		err := DownloadStorageObjectAll(context.Background(), mockApi, "", "/", 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		exists, err := afero.DirExists(fsys, "/private")
		assert.NoError(t, err)
		assert.True(t, exists)
		exists, err = afero.DirExists(fsys, "/test")
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("downloads empty bucket to new directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/object/private").
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "Not Found"})
		gock.New("http://127.0.0.1").
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{{
				Id:        "private",
				Name:      "private",
				CreatedAt: "2023-10-13T17:48:58.491Z",
				UpdatedAt: "2023-10-13T17:48:58.491Z",
			}})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		// Run test
		err := DownloadStorageObjectAll(context.Background(), mockApi, "/private", "/tmp", 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		exists, err := afero.DirExists(fsys, "/private")
		assert.NoError(t, err)
		assert.False(t, exists)
		exists, err = afero.DirExists(fsys, "/tmp")
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("throws error on empty directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		// Run test
		err := DownloadStorageObjectAll(context.Background(), mockApi, "private/dir/", "/", 1, fsys)
		// Check error
		assert.ErrorContains(t, err, "Object not found: private/dir/")
		assert.Empty(t, apitest.ListUnmatchedRequests())
		exists, err := afero.DirExists(fsys, "/private")
		assert.NoError(t, err)
		assert.False(t, exists)
	})

	t.Run("downloads objects to existing directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
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
			Get("/storage/v1/object/private/tmp/abstract.pdf").
			Reply(http.StatusOK)
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
			Get("/storage/v1/object/private/tmp/docs/readme.md").
			Reply(http.StatusOK)
		// Run test
		err := DownloadStorageObjectAll(context.Background(), mockApi, "private/tmp/", "/", 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		exists, err := afero.Exists(fsys, "/tmp/abstract.pdf")
		assert.NoError(t, err)
		assert.True(t, exists)
		exists, err = afero.Exists(fsys, "/tmp/docs/readme.md")
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("downloads object to existing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{mockFile})
		gock.New("http://127.0.0.1").
			Get("/storage/v1/object/private/abstract.pdf").
			Reply(http.StatusOK)
		// Run test
		err := DownloadStorageObjectAll(context.Background(), mockApi, "/private/abstract.pdf", "/tmp/file", 1, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		exists, err := afero.DirExists(fsys, "/private")
		assert.NoError(t, err)
		assert.False(t, exists)
		exists, err = afero.Exists(fsys, "/tmp/file")
		assert.NoError(t, err)
		assert.True(t, exists)
	})
}
