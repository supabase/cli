package ls

import (
	"context"
	"fmt"
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

func TestStorageLS(t *testing.T) {
	t.Run("lists buckets", func(t *testing.T) {
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
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]client.BucketResponse{})
		// Run test
		err := Run(context.Background(), "ss:///", false, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on invalid URL", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "", false, fsys)
		// Check error
		assert.ErrorIs(t, err, errInvalidURL)
	})

	t.Run("throws error on invalid project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "ss:///", false, fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotLinked)
	})

	t.Run("lists objects recursive", func(t *testing.T) {
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
		err := Run(context.Background(), "ss:///", true, fsys)
		// Check error
		assert.NoError(t, err)
	})
}

func TestListStoragePaths(t *testing.T) {
	// Setup valid project ref
	projectRef := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("lists bucket paths by prefix", func(t *testing.T) {
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
		// Run test
		paths, err := ListStoragePaths(context.Background(), projectRef, "te")
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"test/"}, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on bucket service unavailable", func(t *testing.T) {
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
		paths, err := ListStoragePaths(context.Background(), projectRef, "/")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("lists object paths by prefix", func(t *testing.T) {
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
			Post("/storage/v1/object/list/bucket").
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{{
				Name: "folder",
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
		// Run test
		paths, err := ListStoragePaths(context.Background(), projectRef, "bucket/")
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"folder/", "abstract.pdf"}, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on object service unavailable", func(t *testing.T) {
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
			Post("/storage/v1/object/list/bucket").
			Reply(http.StatusServiceUnavailable)
		// Run test
		paths, err := ListStoragePaths(context.Background(), projectRef, "bucket/")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("lists object paths with pagination", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		expected := make([]string, client.PAGE_LIMIT)
		resp := make([]client.ObjectResponse, client.PAGE_LIMIT)
		for i := 0; i < len(resp); i++ {
			resp[i] = client.ObjectResponse{Name: fmt.Sprintf("dir_%d", i)}
			expected[i] = resp[i].Name + "/"
		}
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/bucket").
			JSON(client.ListObjectsQuery{
				Prefix: "",
				Search: "dir",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON(resp)
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/bucket").
			JSON(client.ListObjectsQuery{
				Prefix: "",
				Search: "dir",
				Limit:  client.PAGE_LIMIT,
				Offset: client.PAGE_LIMIT,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{})
		// Run test
		paths, err := ListStoragePaths(context.Background(), projectRef, "/bucket/dir")
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, expected, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestListStoragePathsAll(t *testing.T) {
	// Setup valid project ref
	projectRef := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("lists nested object paths", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		// List buckets
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
		// List folders
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/test").
			JSON(client.ListObjectsQuery{
				Prefix: "",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{{
				Name: "folder",
			}})
		// List files
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "folder/",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
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
		// Run test
		paths, err := ListStoragePathsAll(context.Background(), projectRef, "")
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"private/folder/abstract.pdf", "test/"}, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("returns partial result on error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: "service-key",
			}})
		// List folders
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{{
				Name: "error",
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
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "empty/",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]client.ObjectResponse{})
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Post("/storage/v1/object/list/private").
			JSON(client.ListObjectsQuery{
				Prefix: "error/",
				Search: "",
				Limit:  client.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusServiceUnavailable)
		// Run test
		paths, err := ListStoragePathsAll(context.Background(), projectRef, "private/")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.ElementsMatch(t, []string{"private/abstract.pdf"}, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestSplitBucketPrefix(t *testing.T) {
	t.Run("splits empty path", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("")
		assert.Equal(t, bucket, "")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits root path", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("/")
		assert.Equal(t, bucket, "")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits no slash", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("bucket")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits prefix slash", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("/bucket")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits suffix slash", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("bucket/")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits file path", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("/bucket/folder/name.png")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "folder/name.png")
	})

	t.Run("splits dir path", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("/bucket/folder/")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "folder/")
	})
}

func TestParseStorageURL(t *testing.T) {
	t.Run("parses valid url", func(t *testing.T) {
		path, err := ParseStorageURL("ss:///bucket/folder/name.png")
		assert.NoError(t, err)
		assert.Equal(t, path, "/bucket/folder/name.png")
	})

	t.Run("throws error on invalid host", func(t *testing.T) {
		path, err := ParseStorageURL("ss://bucket")
		assert.ErrorIs(t, err, errInvalidURL)
		assert.Empty(t, path)
	})

	t.Run("throws error on missing path", func(t *testing.T) {
		path, err := ParseStorageURL("ss:")
		assert.ErrorIs(t, err, errInvalidURL)
		assert.Empty(t, path)
	})

	t.Run("throws error on invalid scheme", func(t *testing.T) {
		path, err := ParseStorageURL(".")
		assert.ErrorIs(t, err, errInvalidURL)
		assert.Empty(t, path)
	})

	t.Run("throws error on invalid url", func(t *testing.T) {
		path, err := ParseStorageURL(":")
		assert.ErrorContains(t, err, "missing protocol scheme")
		assert.Empty(t, path)
	})
}
