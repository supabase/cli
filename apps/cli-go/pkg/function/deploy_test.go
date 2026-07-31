package function

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
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

// captureBody records the request body without consuming it, so tests can assert
// on the exact payload sent to a mocked endpoint.
func captureBody(out *[]byte) gock.MatchFunc {
	return func(req *http.Request, _ *gock.Request) (bool, error) {
		if req.Body == nil {
			return true, nil
		}
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return false, err
		}
		req.Body = io.NopCloser(bytes.NewReader(body))
		*out = body
		return true, nil
	}
}

func mockFunctionList(functions ...api.FunctionResponse) {
	gock.New(mockApiHost).
		Get("/v1/projects/" + mockProject + "/functions").
		Reply(http.StatusOK).
		JSON(functions)
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
		mockFunctionList()
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

	t.Run("retries single slug after rate limit", func(t *testing.T) {
		c := config.FunctionConfig{"demo": {
			Enabled:    true,
			Entrypoint: "testdata/shared/whatever.ts",
		}}
		// Setup in-memory fs
		fsys := testImports
		// Setup mock api
		defer gock.OffAll()
		mockFunctionList()
		gock.New(mockApiHost).
			Post("/v1/projects/"+mockProject+"/functions/deploy").
			MatchParam("slug", "demo").
			Reply(http.StatusTooManyRequests).
			SetHeader("Retry-After", "0").
			JSON(map[string]string{"message": "Too Many Requests"})
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
		mockFunctionList()
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

	t.Run("retries bulk update after rate limit reset", func(t *testing.T) {
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
		mockFunctionList()
		for slug := range c {
			gock.New(mockApiHost).
				Post("/v1/projects/"+mockProject+"/functions/deploy").
				MatchParam("slug", slug).
				Reply(http.StatusCreated).
				JSON(api.DeployFunctionResponse{Id: slug})
		}
		gock.New(mockApiHost).
			Put("/v1/projects/"+mockProject+"/functions").
			Reply(http.StatusTooManyRequests).
			SetHeader("X-RateLimit-Reset", "0").
			JSON(map[string]string{"message": "Too Many Requests"})
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

	t.Run("bulk updates successful uploads when one fails", func(t *testing.T) {
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
		mockFunctionList()
		gock.New(mockApiHost).
			Post("/v1/projects/"+mockProject+"/functions/deploy").
			MatchParam("slug", "test-ts").
			Reply(http.StatusCreated).
			JSON(api.DeployFunctionResponse{Id: "test-ts", Name: "test-ts", Slug: "test-ts"})
		gock.New(mockApiHost).
			Post("/v1/projects/"+mockProject+"/functions/deploy").
			MatchParam("slug", "test-js").
			Reply(http.StatusConflict).
			JSON(map[string]string{"message": "deployment already exists"})
		var bulkBody []byte
		gock.New(mockApiHost).
			Put("/v1/projects/"+mockProject+"/functions").
			AddMatcher(captureBody(&bulkBody)).
			Reply(http.StatusOK).
			JSON(api.BulkUpdateFunctionResponse{})
		// Run test
		err := client.Deploy(context.Background(), c, fsys)
		// Check error
		assert.ErrorContains(t, err, "unexpected deploy status 409")
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
		var toUpdate api.BulkUpdateFunctionBody
		require.NoError(t, json.Unmarshal(bulkBody, &toUpdate))
		require.Len(t, toUpdate, 1)
		assert.Equal(t, "test-ts", toUpdate[0].Slug)
	})

	t.Run("skips bulk update when all uploads fail", func(t *testing.T) {
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
		mockFunctionList()
		for slug := range c {
			gock.New(mockApiHost).
				Post("/v1/projects/"+mockProject+"/functions/deploy").
				MatchParam("slug", slug).
				Reply(http.StatusConflict).
				JSON(map[string]string{"message": "deployment already exists"})
		}
		// Run test
		err := client.Deploy(context.Background(), c, fsys)
		// Check error
		assert.ErrorContains(t, err, "unexpected deploy status 409")
		// No bulk update is mocked, so any PUT would show up as unmatched
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
	})

	t.Run("reports upload and bulk update failures together", func(t *testing.T) {
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
		mockFunctionList()
		gock.New(mockApiHost).
			Post("/v1/projects/"+mockProject+"/functions/deploy").
			MatchParam("slug", "test-ts").
			Reply(http.StatusCreated).
			JSON(api.DeployFunctionResponse{Id: "test-ts", Name: "test-ts", Slug: "test-ts"})
		gock.New(mockApiHost).
			Post("/v1/projects/"+mockProject+"/functions/deploy").
			MatchParam("slug", "test-js").
			Reply(http.StatusConflict).
			JSON(map[string]string{"message": "deployment already exists"})
		gock.New(mockApiHost).
			Put("/v1/projects/"+mockProject+"/functions").
			Reply(http.StatusBadRequest).
			JSON(map[string]string{"message": "bulk update rejected"})
		// Run test
		err := client.Deploy(context.Background(), c, fsys)
		// Check error
		assert.ErrorContains(t, err, "unexpected deploy status 409")
		assert.ErrorContains(t, err, "unexpected bulk update status 400")
		assert.Empty(t, gock.Pending())
		assert.Empty(t, gock.GetUnmatchedRequests())
	})

	t.Run("preserves remote verify_jwt when not configured", func(t *testing.T) {
		c := config.FunctionConfig{"demo": {
			Enabled:    true,
			Entrypoint: "testdata/shared/whatever.ts",
		}}
		// Setup in-memory fs
		fsys := testImports
		// Setup mock api
		defer gock.OffAll()
		mockFunctionList(api.FunctionResponse{
			Id:        "demo",
			Name:      "demo",
			Slug:      "demo",
			VerifyJwt: cast.Ptr(false),
		})
		gock.New(mockApiHost).
			Post("/v1/projects/"+mockProject+"/functions/deploy").
			MatchParam("slug", "demo").
			BodyString(`"verify_jwt":false`).
			Reply(http.StatusCreated).
			JSON(api.DeployFunctionResponse{})
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
		mockFunctionList()
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
