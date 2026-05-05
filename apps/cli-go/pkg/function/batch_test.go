package function

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/config"
)

type MockBundler struct {
}

func (b *MockBundler) Bundle(ctx context.Context, slug, entrypoint, importMap string, staticFiles []string, output io.Writer) (FunctionDeployMetadata, error) {
	if staticFiles == nil {
		staticFiles = []string{}
	}
	return FunctionDeployMetadata{
		Name:           &slug,
		EntrypointPath: entrypoint,
		ImportMapPath:  &importMap,
		StaticPatterns: &staticFiles,
	}, nil
}

func mockClient(t *testing.T) EdgeRuntimeAPI {
	apiClient, err := api.NewClientWithResponses(mockApiHost)
	require.NoError(t, err)
	return NewEdgeRuntimeAPI(mockProject, *apiClient, func(era *EdgeRuntimeAPI) {
		era.eszip = &MockBundler{}
	})
}

const (
	mockApiHost = "https://api.supabase.com"
	mockProject = "test-project"
)

func TestUpsertFunctions(t *testing.T) {
	client := mockClient(t)

	t.Run("deploys with bulk update", func(t *testing.T) {
		// t.Cleanup(mockClock(100 * time.Millisecond))
		// Setup mock api
		defer gock.OffAll()
		gock.New(mockApiHost).
			Get("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{{Slug: "test-a"}})
		gock.New(mockApiHost).
			Patch("/v1/projects/" + mockProject + "/functions/test-a").
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Slug: "test-a"})
		gock.New(mockApiHost).
			Post("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Slug: "test-b"})
		gock.New(mockApiHost).
			Put("/v1/projects/" + mockProject + "/functions").
			ReplyError(errors.New("network error"))
		gock.New(mockApiHost).
			Put("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusServiceUnavailable)
		gock.New(mockApiHost).
			Put("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusOK).
			JSON(api.V1BulkUpdateFunctionsResponse{})
		// Run test
		err := client.UpsertFunctions(context.Background(), config.FunctionConfig{
			"test-a": {Enabled: true},
			"test-b": {Enabled: true},
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
	})

	t.Run("skips disabled and unchanged", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(mockApiHost).
			Get("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{{
				Slug:       "test-a",
				VerifyJwt:  cast.Ptr(true),
				EzbrSha256: cast.Ptr("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
			}})
		// Run test
		err := client.UpsertFunctions(context.Background(), config.FunctionConfig{
			"test-a": {Enabled: true, VerifyJWT: true},
			"test-b": {Enabled: false},
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
	})

	t.Run("handles concurrent deploy", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(mockApiHost).
			Get("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{})
		gock.New(mockApiHost).
			Post("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusBadRequest).
			BodyString("Duplicated function slug")
		gock.New(mockApiHost).
			Patch("/v1/projects/" + mockProject + "/functions/test").
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Slug: "test"})
		// Run test
		err := client.UpsertFunctions(context.Background(), config.FunctionConfig{
			"test": {Enabled: true},
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
	})

	t.Run("retries on network failure", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(mockApiHost).
			Get("/v1/projects/" + mockProject + "/functions").
			ReplyError(errors.New("network error"))
		gock.New(mockApiHost).
			Get("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusServiceUnavailable)
		gock.New(mockApiHost).
			Get("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusBadRequest)
		// Run test
		err := client.UpsertFunctions(context.Background(), nil)
		// Check error
		assert.ErrorContains(t, err, "unexpected list functions status 400:")
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
	})
}

func TestCreateFunction(t *testing.T) {
	client := mockClient(t)
	// Setup mock api
	defer gock.OffAll()
	gock.New(mockApiHost).
		Get("/v1/projects/" + mockProject + "/functions").
		Reply(http.StatusOK).
		JSON([]api.FunctionResponse{})
	gock.New(mockApiHost).
		Post("/v1/projects/" + mockProject + "/functions").
		ReplyError(errors.New("network error"))
	gock.New(mockApiHost).
		Post("/v1/projects/" + mockProject + "/functions").
		Reply(http.StatusServiceUnavailable)
	gock.New(mockApiHost).
		Post("/v1/projects/" + mockProject + "/functions").
		Reply(http.StatusCreated).
		JSON(api.FunctionResponse{Slug: "test"})
	// Run test
	err := client.UpsertFunctions(context.Background(), config.FunctionConfig{
		"test": {Enabled: true},
	})
	// Check error
	assert.NoError(t, err)
	assert.Empty(t, gock.Pending())
	assert.Empty(t, gock.GetUnmatchedRequests())
}

func TestUpdateFunction(t *testing.T) {
	client := mockClient(t)
	// Setup mock api
	defer gock.OffAll()
	gock.New(mockApiHost).
		Get("/v1/projects/" + mockProject + "/functions").
		Reply(http.StatusOK).
		JSON([]api.FunctionResponse{{Slug: "test"}})
	gock.New(mockApiHost).
		Patch("/v1/projects/" + mockProject + "/functions/test").
		ReplyError(errors.New("network error"))
	gock.New(mockApiHost).
		Patch("/v1/projects/" + mockProject + "/functions/test").
		Reply(http.StatusServiceUnavailable)
	gock.New(mockApiHost).
		Patch("/v1/projects/" + mockProject + "/functions/test").
		Reply(http.StatusOK).
		JSON(api.FunctionResponse{Slug: "test"})
	// Run test
	err := client.UpsertFunctions(context.Background(), config.FunctionConfig{
		"test": {Enabled: true},
	})
	// Check error
	assert.NoError(t, err)
	assert.Empty(t, gock.Pending())
	assert.Empty(t, gock.GetUnmatchedRequests())
}
