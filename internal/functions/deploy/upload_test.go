package deploy

import (
	"bytes"
	"context"
	"embed"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/config"
)

//go:embed testdata
var testImports embed.FS

type MockFS struct {
	mock.Mock
}

func (m *MockFS) ReadFile(srcPath string, w io.Writer) error {
	_ = m.Called(srcPath)
	data, err := testImports.ReadFile(srcPath)
	if err != nil {
		return err
	}
	if _, err := w.Write(data); err != nil {
		return err
	}
	return nil
}

func TestImportPaths(t *testing.T) {
	t.Run("iterates all import paths", func(t *testing.T) {
		// Setup in-memory fs
		fsys := MockFS{}
		fsys.On("ReadFile", "/modules/my-module.ts").Once()
		fsys.On("ReadFile", "testdata/modules/imports.ts").Once()
		fsys.On("ReadFile", "testdata/geometries/Geometries.js").Once()
		// Run test
		im := utils.ImportMap{}
		err := walkImportPaths("testdata/modules/imports.ts", im, fsys.ReadFile)
		// Check error
		assert.NoError(t, err)
		fsys.AssertExpectations(t)
	})

	t.Run("iterates with import map", func(t *testing.T) {
		// Setup in-memory fs
		fsys := MockFS{}
		fsys.On("ReadFile", "/modules/my-module.ts").Once()
		fsys.On("ReadFile", "testdata/modules/imports.ts").Once()
		fsys.On("ReadFile", "testdata/geometries/Geometries.js").Once()
		fsys.On("ReadFile", "testdata/shared/whatever.ts").Once()
		fsys.On("ReadFile", "testdata/nested/index.ts").Once()
		// Run test
		im := utils.ImportMap{Imports: map[string]string{
			"module-name/": "../shared/",
		}}
		err := walkImportPaths("testdata/modules/imports.ts", im, fsys.ReadFile)
		// Check error
		assert.NoError(t, err)
		fsys.AssertExpectations(t)
	})
}

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
		fsys := afero.FromIOFS{FS: testImports}
		// Run test
		err := writeForm(form, api.FunctionDeployMetadata{
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
		fsys := afero.NewMemMapFs()
		// Run test
		err := writeForm(form, api.FunctionDeployMetadata{
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
		fsys := afero.NewMemMapFs()
		// Run test
		err := writeForm(form, api.FunctionDeployMetadata{
			StaticPatterns: cast.Ptr([]string{"testdata"}),
		}, fsys)
		// Check error
		assert.ErrorContains(t, err, "file path is a directory:")
	})
}

func TestDeployAll(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("deploys single slug", func(t *testing.T) {
		c := config.FunctionConfig{"demo": {
			Entrypoint: "testdata/shared/whatever.ts",
		}}
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testImports}
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/"+flags.ProjectRef+"/functions/deploy").
			MatchParam("slug", "demo").
			Reply(http.StatusCreated).
			JSON(api.DeployFunctionResponse{})
		// Run test
		err := deploy(context.Background(), c, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("deploys multiple slugs", func(t *testing.T) {
		c := config.FunctionConfig{
			"test-ts": {Entrypoint: "testdata/shared/whatever.ts"},
			"test-js": {Entrypoint: "testdata/geometries/Geometries.js"},
		}
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testImports}
		// Setup mock api
		defer gock.OffAll()
		body := api.V1BulkUpdateFunctionsJSONBody{}
		for slug := range c {
			gock.New(utils.DefaultApiHost).
				Post("/v1/projects/"+flags.ProjectRef+"/functions/deploy").
				MatchParam("slug", slug).
				Reply(http.StatusCreated).
				JSON(api.DeployFunctionResponse{Id: slug})
			body = append(body, api.BulkUpdateFunctionBody{Id: slug})
		}
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + flags.ProjectRef + "/functions").
			JSON(body).
			Reply(http.StatusOK).
			JSON(api.BulkUpdateFunctionResponse{})
		// Run test
		err := deploy(context.Background(), c, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		errNetwork := errors.New("network")
		c := config.FunctionConfig{"demo": {}}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/"+flags.ProjectRef+"/functions/deploy").
			MatchParam("slug", "demo").
			ReplyError(errNetwork)
		// Run test
		err := deploy(context.Background(), c, fsys)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
