package function

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"testing"
	fs "testing/fstest"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/config"
)

func assertFormEqual(t *testing.T, actual []byte) {
	snapshot := path.Join("testdata", path.Base(t.Name())+".form")
	expected, err := testImports.ReadFile(snapshot)
	if errors.Is(err, os.ErrNotExist) {
		assert.NoError(t, os.WriteFile(snapshot, actual, 0600))
	}
	assert.Equal(t, string(expected), string(actual))
}

func TestWriteForm(t *testing.T) {
	t.Run("writes import map", func(t *testing.T) {
		var buf bytes.Buffer
		form := multipart.NewWriter(&buf)
		require.NoError(t, form.SetBoundary("test"))
		// Setup in-memory fs
		fsys := testImports
		// Run test
		err := writeForm(form, FunctionDeployMetadata{
			Name:           cast.Ptr("nested"),
			VerifyJwt:      cast.Ptr(true),
			EntrypointPath: "testdata/nested/index.ts",
			ImportMapPath:  cast.Ptr("testdata/nested/deno.json"),
			StaticPatterns: cast.Ptr([]string{"testdata/*/*.js"}),
		}, fsys)
		// Check error
		assert.NoError(t, err)
		assertFormEqual(t, buf.Bytes())
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		var buf bytes.Buffer
		form := multipart.NewWriter(&buf)
		require.NoError(t, form.SetBoundary("test"))
		// Setup in-memory fs
		fsys := fs.MapFS{}
		// Run test
		err := writeForm(form, FunctionDeployMetadata{
			ImportMapPath: cast.Ptr("testdata/import_map.json"),
		}, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on directory path", func(t *testing.T) {
		var buf bytes.Buffer
		form := multipart.NewWriter(&buf)
		require.NoError(t, form.SetBoundary("test"))
		// Setup in-memory fs
		fsys := testImports
		// Run test
		err := writeForm(form, FunctionDeployMetadata{
			StaticPatterns: cast.Ptr([]string{"testdata"}),
		}, fsys)
		// Check error
		assert.ErrorContains(t, err, "file path is a directory:")
	})
}

func TestDeployAll(t *testing.T) {
	apiClient, err := api.NewClientWithResponses(mockApiHost)
	require.NoError(t, err)
	client := NewEdgeRuntimeAPI(mockProject, *apiClient)

	t.Run("deploys single slug", func(t *testing.T) {
		c := config.FunctionConfig{"demo": {
			Enabled:    true,
			Entrypoint: "testdata/shared/whatever.ts",
		}}
		// Setup in-memory fs
		fsys := testImports
		// Setup mock api
		defer gock.OffAll()
		gock.New(mockApiHost).
			Post("/v1/projects/"+mockProject+"/functions/deploy").
			MatchParam("slug", "demo").
			Reply(http.StatusCreated).
			JSON(api.DeployFunctionResponse{})
		// Run test
		err := client.Deploy(context.Background(), c, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
	})

	t.Run("deploys multiple slugs", func(t *testing.T) {
		c := config.FunctionConfig{
			"test-ts": {
				Enabled:    true,
				Entrypoint: "testdata/shared/whatever.ts",
			},
			"test-js": {
				Enabled:    true,
				Entrypoint: "testdata/geometries/Geometries.js",
			},
		}
		// Setup in-memory fs
		fsys := testImports
		// Setup mock api
		defer gock.OffAll()
		for slug := range c {
			gock.New(mockApiHost).
				Post("/v1/projects/"+mockProject+"/functions/deploy").
				MatchParam("slug", slug).
				Reply(http.StatusCreated).
				JSON(api.DeployFunctionResponse{Id: slug})
		}
		gock.New(mockApiHost).
			Put("/v1/projects/" + mockProject + "/functions").
			Reply(http.StatusOK).
			JSON(api.BulkUpdateFunctionResponse{})
		// Run test
		err := client.Deploy(context.Background(), c, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		errNetwork := errors.New("network")
		c := config.FunctionConfig{"demo": {Enabled: true}}
		// Setup in-memory fs
		fsys := fs.MapFS{}
		// Setup mock api
		defer gock.OffAll()
		gock.New(mockApiHost).
			Post("/v1/projects/"+mockProject+"/functions/deploy").
			MatchParam("slug", "demo").
			ReplyError(errNetwork)
		// Run test
		err := client.Deploy(context.Background(), c, fsys)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
	})
}
