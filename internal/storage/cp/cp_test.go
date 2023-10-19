package cp

import (
	"context"
	"io/fs"
	"net/http"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestStorageCP(t *testing.T) {
	t.Run("copy local to remote", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		projectRef := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/private/file").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), utils.ProjectRefPath, "ss:///private/file", false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		projectRef := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]client.BucketResponse{})
		// Run test
		err := Run(context.Background(), "abstract.pdf", "ss:///private", true, fsys)
		// Check error
		assert.ErrorIs(t, err, fs.ErrNotExist)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("copy remote to local", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		projectRef := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/object/private/file").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), "ss:///private/file", "abstract.pdf", false, fsys)
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
		projectRef := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]client.BucketResponse{})
		// Run test
		err := Run(context.Background(), "ss:///private", ".", true, fsys)
		// Check error
		assert.ErrorContains(t, err, "Object not found: /private")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on invalid src", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), ":", ".", false, fsys)
		// Check error
		assert.ErrorContains(t, err, "missing protocol scheme")
	})

	t.Run("throws error on invalid dst", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), ".", ":", false, fsys)
		// Check error
		assert.ErrorContains(t, err, "missing protocol scheme")
	})

	t.Run("throws error on missing project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), ".", ".", false, fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotLinked)
	})

	t.Run("throws error on missing project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		projectRef := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644))
		// Run test
		err := Run(context.Background(), ".", ".", false, fsys)
		// Check error
		assert.ErrorIs(t, err, errUnsupportedOperation)
	})
}

func TestUploadAll(t *testing.T) {
	// Setup valid project ref
	projectRef := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("uploads directory to new bucket", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, "/tmp/readme.md", []byte{}, 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]client.BucketResponse{})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/tmp/readme.md").
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "Bucket not found"})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON(client.CreateBucketResponse{Name: "tmp"})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/tmp/readme.md").
			Reply(http.StatusOK)
		// Run test
		err := UploadStorageObjectAll(context.Background(), projectRef, "", "/tmp", fsys)
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
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]client.BucketResponse{})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/tmp/readme.md").
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "Bucket not found"})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/bucket").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := UploadStorageObjectAll(context.Background(), projectRef, "", "/tmp", fsys)
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
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{{
				Name: "dir",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/private/dir/tmp/readme.md").
			Reply(http.StatusOK)
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/private/dir/tmp/docs/api.md").
			Reply(http.StatusOK)
		// Run test
		err := UploadStorageObjectAll(context.Background(), projectRef, "/private/dir/", "/tmp", fsys)
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
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]client.BucketResponse{{
				Id:        "private",
				Name:      "private",
				CreatedAt: "2023-10-13T17:48:58.491Z",
				UpdatedAt: "2023-10-13T17:48:58.491Z",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/private/readme.md").
			Reply(http.StatusOK)
		// Run test
		err := UploadStorageObjectAll(context.Background(), projectRef, "private", "/tmp/readme.md", fsys)
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
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{{
				Name:           "file",
				Id:             utils.Ptr("9b7f9f48-17a6-4ca8-b14a-39b0205a63e9"),
				UpdatedAt:      utils.Ptr("2023-10-13T18:08:22.068Z"),
				CreatedAt:      utils.Ptr("2023-10-13T18:08:22.068Z"),
				LastAccessedAt: utils.Ptr("2023-10-13T18:08:22.068Z"),
				Metadata: &client.ObjectMetadata{
					ETag:           `"887ea9be3c68e6f2fca7fd2d7c77d8fe"`,
					Size:           82702,
					Mimetype:       "application/pdf",
					CacheControl:   "max-age=3600",
					LastModified:   "2023-10-13T18:08:22.000Z",
					ContentLength:  82702,
					HttpStatusCode: 200,
				},
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/private/file").
			Reply(http.StatusOK)
		// Run test
		err := UploadStorageObjectAll(context.Background(), projectRef, "private/file", "/tmp/readme.md", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := UploadStorageObjectAll(context.Background(), projectRef, "", ".", fsys)
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestDownloadAll(t *testing.T) {
	// Setup valid project ref
	projectRef := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("downloads buckets to existing directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]client.BucketResponse{{
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
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/test").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{})
		// Run test
		err := DownloadStorageObjectAll(context.Background(), projectRef, "", "/", fsys)
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
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/object/private").
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "Not Found"})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]client.BucketResponse{{
				Id:        "private",
				Name:      "private",
				CreatedAt: "2023-10-13T17:48:58.491Z",
				UpdatedAt: "2023-10-13T17:48:58.491Z",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{})
		// Run test
		err := DownloadStorageObjectAll(context.Background(), projectRef, "/private", "/tmp", fsys)
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
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{})
		// Run test
		err := DownloadStorageObjectAll(context.Background(), projectRef, "private/dir/", "/", fsys)
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
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		// Lists /private/tmp directory
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "tmp/",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{{
				Name: "docs",
			}, {
				Name:           "abstract.pdf",
				Id:             utils.Ptr("9b7f9f48-17a6-4ca8-b14a-39b0205a63e9"),
				UpdatedAt:      utils.Ptr("2023-10-13T18:08:22.068Z"),
				CreatedAt:      utils.Ptr("2023-10-13T18:08:22.068Z"),
				LastAccessedAt: utils.Ptr("2023-10-13T18:08:22.068Z"),
				Metadata: &client.ObjectMetadata{
					ETag:           `"887ea9be3c68e6f2fca7fd2d7c77d8fe"`,
					Size:           82702,
					Mimetype:       "application/pdf",
					CacheControl:   "max-age=3600",
					LastModified:   "2023-10-13T18:08:22.000Z",
					ContentLength:  82702,
					HttpStatusCode: 200,
				},
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/object/private/tmp/abstract.pdf").
			Reply(http.StatusOK)
		// Lists /private/tmp/docs directory
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "tmp/docs/",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{{
				Name:           "readme.pdf",
				Id:             utils.Ptr("9b7f9f48-17a6-4ca8-b14a-39b0205a63e9"),
				UpdatedAt:      utils.Ptr("2023-10-13T18:08:22.068Z"),
				CreatedAt:      utils.Ptr("2023-10-13T18:08:22.068Z"),
				LastAccessedAt: utils.Ptr("2023-10-13T18:08:22.068Z"),
				Metadata: &client.ObjectMetadata{
					ETag:           `"887ea9be3c68e6f2fca7fd2d7c77d8fe"`,
					Size:           82702,
					Mimetype:       "application/pdf",
					CacheControl:   "max-age=3600",
					LastModified:   "2023-10-13T18:08:22.000Z",
					ContentLength:  82702,
					HttpStatusCode: 200,
				},
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/object/private/tmp/docs/readme.pdf").
			Reply(http.StatusOK)
		// Run test
		err := DownloadStorageObjectAll(context.Background(), projectRef, "private/tmp/", "/", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		exists, err := afero.Exists(fsys, "/tmp/abstract.pdf")
		assert.NoError(t, err)
		assert.True(t, exists)
		exists, err = afero.Exists(fsys, "/tmp/docs/readme.pdf")
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("downloads object to existing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{{
				Name:           "abstract.pdf",
				Id:             utils.Ptr("9b7f9f48-17a6-4ca8-b14a-39b0205a63e9"),
				UpdatedAt:      utils.Ptr("2023-10-13T18:08:22.068Z"),
				CreatedAt:      utils.Ptr("2023-10-13T18:08:22.068Z"),
				LastAccessedAt: utils.Ptr("2023-10-13T18:08:22.068Z"),
				Metadata: &client.ObjectMetadata{
					ETag:           `"887ea9be3c68e6f2fca7fd2d7c77d8fe"`,
					Size:           82702,
					Mimetype:       "application/pdf",
					CacheControl:   "max-age=3600",
					LastModified:   "2023-10-13T18:08:22.000Z",
					ContentLength:  82702,
					HttpStatusCode: 200,
				},
			}})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/storage/v1/object/private/abstract.pdf").
			Reply(http.StatusOK)
		// Run test
		err := DownloadStorageObjectAll(context.Background(), projectRef, "/private/abstract.pdf", "/tmp/file", fsys)
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
