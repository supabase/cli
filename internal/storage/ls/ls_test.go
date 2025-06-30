package ls

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/oapi-codegen/nullable"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/storage/client"
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

func TestStorageLS(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	apiKeys := []api.ApiKeyResponse{{
		Name:   "service_role",
		ApiKey: nullable.NewNullableWithValue("service-key"),
	}}

	t.Run("lists buckets", func(t *testing.T) {
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
		assert.ErrorIs(t, err, client.ErrInvalidURL)
	})

	t.Run("lists objects recursive", func(t *testing.T) {
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
			JSON([]storage.BucketResponse{{
				Id:        "private",
				Name:      "private",
				CreatedAt: "2023-10-13T17:48:58.491Z",
				UpdatedAt: "2023-10-13T17:48:58.491Z",
			}})
		gock.New("https://" + utils.GetSupabaseHost(flags.ProjectRef)).
			Post("/storage/v1/object/list/private").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		// Run test
		err := Run(context.Background(), "ss:///", true, fsys)
		// Check error
		assert.NoError(t, err)
	})
}

func TestListStoragePaths(t *testing.T) {
	t.Run("lists bucket paths by prefix", func(t *testing.T) {
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
		// Run test
		paths, err := ListStoragePaths(context.Background(), mockApi, "te")
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"test/"}, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on bucket service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/bucket").
			Reply(http.StatusServiceUnavailable)
		// Run test
		paths, err := ListStoragePaths(context.Background(), mockApi, "/")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("lists object paths by prefix", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/bucket").
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{{
				Name: "folder",
			}, mockFile})
		// Run test
		paths, err := ListStoragePaths(context.Background(), mockApi, "bucket/")
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"folder/", "abstract.pdf"}, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on object service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/bucket").
			Reply(http.StatusServiceUnavailable)
		// Run test
		paths, err := ListStoragePaths(context.Background(), mockApi, "bucket/")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.Empty(t, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("lists object paths with pagination", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		expected := make([]string, storage.PAGE_LIMIT)
		resp := make([]storage.ObjectResponse, storage.PAGE_LIMIT)
		for i := 0; i < len(resp); i++ {
			resp[i] = storage.ObjectResponse{Name: fmt.Sprintf("dir_%d", i)}
			expected[i] = resp[i].Name + "/"
		}
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/bucket").
			JSON(storage.ListObjectsQuery{
				Prefix: "",
				Search: "dir",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON(resp)
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/bucket").
			JSON(storage.ListObjectsQuery{
				Prefix: "",
				Search: "dir",
				Limit:  storage.PAGE_LIMIT,
				Offset: storage.PAGE_LIMIT,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		// Run test
		paths, err := ListStoragePaths(context.Background(), mockApi, "/bucket/dir")
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, expected, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestListStoragePathsAll(t *testing.T) {
	t.Run("lists nested object paths", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		// List buckets
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
		// List folders
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/test").
			JSON(storage.ListObjectsQuery{
				Prefix: "",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			JSON(storage.ListObjectsQuery{
				Prefix: "",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{{
				Name: "folder",
			}})
		// List files
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			JSON(storage.ListObjectsQuery{
				Prefix: "folder/",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{mockFile})
		// Run test
		paths, err := ListStoragePathsAll(context.Background(), mockApi, "")
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"private/folder/abstract.pdf", "test/"}, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("returns partial result on error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		// List folders
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			JSON(storage.ListObjectsQuery{
				Prefix: "",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{{
				Name: "error",
			}, mockFile})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			JSON(storage.ListObjectsQuery{
				Prefix: "empty/",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusOK).
			JSON([]storage.ObjectResponse{})
		gock.New("http://127.0.0.1").
			Post("/storage/v1/object/list/private").
			JSON(storage.ListObjectsQuery{
				Prefix: "error/",
				Search: "",
				Limit:  storage.PAGE_LIMIT,
				Offset: 0,
			}).
			Reply(http.StatusServiceUnavailable)
		// Run test
		paths, err := ListStoragePathsAll(context.Background(), mockApi, "private/")
		// Check error
		assert.ErrorContains(t, err, "Error status 503:")
		assert.ElementsMatch(t, []string{"private/abstract.pdf"}, paths)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
