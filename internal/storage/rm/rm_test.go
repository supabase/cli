package rm

import (
	"context"
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

var mockFile = client.ObjectResponse{
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
}

func TestStorageRM(t *testing.T) {
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

	t.Run("throws error on missing project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), []string{}, false, fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotLinked)
	})

	t.Run("removes multiple objects", func(t *testing.T) {
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
			Delete("/storage/v1/object/private").
			JSON(client.DeleteObjectsRequest{Prefixes: []string{
				"abstract.pdf",
				"docs/readme.md",
			}}).
			Reply(http.StatusOK).
			JSON([]client.DeleteObjectsResponse{{
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
		// Delete /test/ bucket
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/test").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Delete("/storage/v1/object/test").
			JSON(client.DeleteObjectsRequest{Prefixes: []string{
				"",
			}}).
			Reply(http.StatusOK).
			JSON([]client.DeleteObjectsResponse{})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/test").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Delete("/storage/v1/bucket/test").
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "Bucket not found"})
		// Delete /private/docs/ directory
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Delete("/storage/v1/object/private").
			JSON(client.DeleteObjectsRequest{Prefixes: []string{
				"docs",
			}}).
			Reply(http.StatusOK).
			JSON([]client.DeleteObjectsResponse{})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{mockFile})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Delete("/storage/v1/object/private").
			JSON(client.DeleteObjectsRequest{Prefixes: []string{
				"docs/abstract.pdf",
			}}).
			Reply(http.StatusOK).
			JSON([]client.DeleteObjectsResponse{{
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
	projectRef := apitest.RandomProjectRef()

	t.Run("removes objects by prefix", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		// List /private/tmp/
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
			}})
		// List /private/docs/
		readme := mockFile
		readme.Name = "readme.md"
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "tmp/docs/",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{mockFile, readme})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Delete("/storage/v1/object/private").
			JSON(client.DeleteObjectsRequest{Prefixes: []string{
				"tmp/docs/abstract.pdf",
				"tmp/docs/readme.md",
			}}).
			Reply(http.StatusOK).
			JSON([]client.DeleteObjectsResponse{{
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
		err := RemoveStoragePathAll(context.Background(), projectRef, "private", "tmp/")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("removes empty bucket", func(t *testing.T) {
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
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Delete("/storage/v1/bucket/private").
			Reply(http.StatusOK).
			JSON(client.DeleteBucketResponse{Message: "Successfully deleted"})
		// Run test
		err := RemoveStoragePathAll(context.Background(), projectRef, "private", "")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on empty directory", func(t *testing.T) {
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
		err := RemoveStoragePathAll(context.Background(), projectRef, "private", "dir")
		// Check error
		assert.ErrorContains(t, err, "Object not found: private/dir")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
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
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := RemoveStoragePathAll(context.Background(), projectRef, "private", "")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on delete failure", func(t *testing.T) {
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
			JSON([]client.ObjectResponse{mockFile})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Delete("/storage/v1/object/private").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := RemoveStoragePathAll(context.Background(), projectRef, "private", "")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
