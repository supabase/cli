package mv

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

func TestStorageMV(t *testing.T) {
	t.Run("moves single object", func(t *testing.T) {
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
			Post("/storage/v1/object/move").
			JSON(client.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "readme.md",
				DestinationKey: "docs/file",
			}).
			Reply(http.StatusOK).
			JSON(client.MoveObjectResponse{Message: "Successfully moved"})
		// Run test
		err := Run(context.Background(), "ss:///private/readme.md", "ss:///private/docs/file", false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("moves directory when recursive", func(t *testing.T) {
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
			Post("/storage/v1/object/move").
			JSON(client.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "",
				DestinationKey: "docs",
			}).
			Reply(http.StatusNotFound).
			JSON(map[string]string{"error": "not_found"})
		// List bucket /private/
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{mockFile})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/move").
			JSON(client.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "abstract.pdf",
				DestinationKey: "docs/abstract.pdf",
			}).
			Reply(http.StatusOK).
			JSON(client.MoveObjectResponse{Message: "Successfully moved"})
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

	t.Run("throws error on missing project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "ss:///", "ss:///", false, fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotLinked)
	})

	t.Run("throws error on missing object path", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		projectRef := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644))
		// Run test
		err := Run(context.Background(), "ss:///", "ss:///", false, fsys)
		// Check error
		assert.ErrorIs(t, err, errMissingPath)
	})

	t.Run("throws error on bucket mismatch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		projectRef := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644))
		// Run test
		err := Run(context.Background(), "ss:///bucket/docs", "ss:///private", false, fsys)
		// Check error
		assert.ErrorIs(t, err, errUnsupportedMove)
	})
}

func TestMoveAll(t *testing.T) {
	// Setup valid project ref
	projectRef := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("rename directory within bucket", func(t *testing.T) {
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
			}, mockFile})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/move").
			JSON(client.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "tmp/abstract.pdf",
				DestinationKey: "dir/abstract.pdf",
			}).
			Reply(http.StatusOK).
			JSON(client.MoveObjectResponse{Message: "Successfully moved"})
		// Lists /private/tmp/docs directory
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
			JSON([]client.ObjectResponse{readme})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/move").
			JSON(client.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "tmp/docs/readme.md",
				DestinationKey: "dir/docs/readme.md",
			}).
			Reply(http.StatusOK).
			JSON(client.MoveObjectResponse{Message: "Successfully moved"})
		// Run test
		err := MoveStorageObjectAll(context.Background(), projectRef, "private/tmp/", "private/dir")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("moves object into directory", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		// Lists /private/ bucket
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{mockFile})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/move").
			JSON(client.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "abstract.pdf",
				DestinationKey: "dir/abstract.pdf",
			}).
			Reply(http.StatusOK).
			JSON(client.MoveObjectResponse{Message: "Successfully moved"})
		// Run test
		err := MoveStorageObjectAll(context.Background(), projectRef, "private/", "private/dir")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("moves object out of directory", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		// Lists /private/tmp/ directory
		readme := mockFile
		readme.Name = "readme.md"
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "tmp/",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{readme})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/move").
			JSON(client.MoveObjectRequest{
				BucketId:       "private",
				SourceKey:      "tmp/readme.md",
				DestinationKey: "readme.md",
			}).
			Reply(http.StatusOK).
			JSON(client.MoveObjectResponse{Message: "Successfully moved"})
		// Run test
		err := MoveStorageObjectAll(context.Background(), projectRef, "private/tmp/", "private")
		// Check error
		assert.NoError(t, err)
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
		err := MoveStorageObjectAll(context.Background(), projectRef, "private/tmp/", "private")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on move failure", func(t *testing.T) {
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
			Post("/storage/v1/object/move").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := MoveStorageObjectAll(context.Background(), projectRef, "private/tmp/", "private")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing object", func(t *testing.T) {
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
		err := MoveStorageObjectAll(context.Background(), projectRef, "private/tmp/", "private")
		// Check error
		assert.ErrorContains(t, err, "Object not found: private/tmp/")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
