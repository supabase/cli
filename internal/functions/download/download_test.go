package download

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func TestMain(m *testing.M) {
	// Setup fake deno binary
	if len(os.Args) > 1 && (os.Args[1] == "bundle" || os.Args[1] == "upgrade" || os.Args[1] == "run") {
		msg := os.Getenv("TEST_DENO_ERROR")
		if msg != "" {
			fmt.Fprintln(os.Stderr, msg)
			os.Exit(1)
		}
		os.Exit(0)
	}
	denoPath, err := os.Executable()
	if err != nil {
		log.Fatalln(err)
	}
	utils.DenoPathOverride = denoPath
	// Run test suite
	os.Exit(m.Run())
}

func TestDownloadCommand(t *testing.T) {
	const slug = "test-func"

	t.Run("downloads eszip bundle", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err := fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug + "/body").
			Reply(http.StatusOK)
		// Run test
		err = Run(context.Background(), slug, project, true, false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		err := Run(context.Background(), "@", project, true, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid Function name.")
	})

	t.Run("throws error on failure to install deno", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		err := Run(context.Background(), slug, project, true, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on copy failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid deno path
		_, err := fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Run test
		err = Run(context.Background(), slug, project, true, false, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on missing function", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err := fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound).
			JSON(map[string]string{"message": "Function not found"})
		// Run test
		err = Run(context.Background(), slug, project, true, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "Function test-func does not exist on the Supabase project.")
	})
}

func TestDownloadFunction(t *testing.T) {
	const slug = "test-func"
	// Setup valid project ref
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug + "/body").
			ReplyError(errors.New("network error"))
		// Run test
		err := downloadFunction(context.Background(), project, slug, "")
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug + "/body").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := downloadFunction(context.Background(), project, slug, "")
		// Check error
		assert.ErrorContains(t, err, "Unexpected error downloading Function:")
	})

	t.Run("throws error on extract failure", func(t *testing.T) {
		// Setup deno error
		t.Setenv("TEST_DENO_ERROR", "extract failed")
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug + "/body").
			Reply(http.StatusOK)
		// Run test
		err := downloadFunction(context.Background(), project, slug, "")
		// Check error
		assert.ErrorContains(t, err, "Error downloading function: exit status 1\nextract failed\n")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestGetMetadata(t *testing.T) {
	const slug = "test-func"
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("fallback to default paths", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		meta, err := getFunctionMetadata(context.Background(), project, slug)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, legacyEntrypointPath, *meta.EntrypointPath)
		assert.Equal(t, legacyImportMapPath, *meta.ImportMapPath)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			ReplyError(errors.New("network error"))
		// Run test
		meta, err := getFunctionMetadata(context.Background(), project, slug)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Nil(t, meta)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusServiceUnavailable)
		// Run test
		meta, err := getFunctionMetadata(context.Background(), project, slug)
		// Check error
		assert.ErrorContains(t, err, "Failed to download Function test-func on the Supabase project:")
		assert.Nil(t, meta)
	})
}

func TestRunProducesSameFilesWithOrWithoutUseAPI(t *testing.T) {
	const slug = "test-func"
	project := apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	expected := map[string]string{
		"index.ts":          "export const handler = () => \"ok\"\n",
		"nested/mod.ts":     "export const nested = true\n",
		"nested/utils.ts":   "export const answer = 42\n",
		".env.example":      "SECRET=value\n",
		"README.md":         "# Example function\n",
		"subdir/inner.tsx":  "export default function Component() { return <div /> }\n",
		"package.json":      "{ \"name\": \"edge\" }\n",
		"import_map.jsonc":  "{ \"imports\": {} }\n",
		"types.d.ts":        "export type Handler = () => string\n",
		"subdir/index.mjs":  "export const value = 1;\n",
		"supabase.toml":     "[functions]\nverify_jwt = false\n",
		"nested/nested.txt": "hello world\n",
	}

	tempDir := t.TempDir()
	fsys := afero.NewBasePathFs(afero.NewOsFs(), tempDir)
	require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: project}, fsys))
	prevProjectRef := flags.ProjectRef
	flags.ProjectRef = project
	t.Cleanup(func() { flags.ProjectRef = prevProjectRef })

	wd, err := os.Getwd()
	require.NoError(t, err)
	require.NoError(t, os.Chdir(tempDir))
	t.Cleanup(func() {
		require.NoError(t, os.Chdir(wd))
	})

	prevDocker := dockerRunOnceWithConfig
	dockerRunOnceWithConfig = func(ctx context.Context, config container.Config, hostConfig container.HostConfig, networkingConfig network.NetworkingConfig, containerName string, stdout, stderr io.Writer) error {
		var hostFuncDir string
		for _, bind := range hostConfig.Binds {
			parts := strings.Split(bind, ":")
			if len(parts) < 2 {
				continue
			}
			if parts[1] == utils.DockerDenoDir {
				hostFuncDir = parts[0]
				break
			}
		}
		if hostFuncDir == "" {
			return errors.New("mock docker: missing function directory bind")
		}
		for rel, content := range expected {
			abs := filepath.Join(hostFuncDir, rel)
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(abs, []byte(content), 0o600); err != nil {
				return err
			}
		}
		return nil
	}
	t.Cleanup(func() {
		dockerRunOnceWithConfig = prevDocker
	})

	defer gock.OffAll()

	gock.New(utils.DefaultApiHost).
		Get("/v1/projects/" + project + "/functions/" + slug + "/body").
		Reply(http.StatusOK).
		BodyString("mock eszip")

	require.NoError(t, Run(context.Background(), slug, project, false, false, fsys))
	require.Empty(t, apitest.ListUnmatchedRequests())

	functionDir := filepath.Join(tempDir, utils.FunctionsDir, slug)
	legacyFiles := readDirFiles(t, functionDir)

	require.NoError(t, os.RemoveAll(functionDir))
	gock.OffAll()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	boundary := writer.Boundary()
	for rel, content := range expected {
		header := textproto.MIMEHeader{}
		header.Set("Content-Type", "application/octet-stream")
		// Provide a Supabase-Path header so nested directories are preserved.
		slugged := path.Join(slug, strings.ReplaceAll(rel, string(filepath.Separator), "/"))
		header.Set("Supabase-Path", slugged)
		part, err := writer.CreatePart(header)
		require.NoError(t, err)
		_, err = part.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())

	gock.New(utils.DefaultApiHost).
		Get("/v1/projects/"+project+"/functions/"+slug+"/body").
		MatchHeader("Accept", "multipart/form-data").
		Reply(http.StatusOK).
		SetHeader("Content-Type", "multipart/form-data; boundary="+boundary).
		Body(bytes.NewReader(body.Bytes()))

	require.NoError(t, Run(context.Background(), slug, project, false, true, fsys))
	require.Empty(t, apitest.ListUnmatchedRequests())

	apiFiles := readDirFiles(t, functionDir)
	require.Equal(t, legacyFiles, apiFiles)
}

func readDirFiles(t *testing.T, root string) map[string]string {
	t.Helper()
	files := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		files[filepath.ToSlash(rel)] = string(data)
		return nil
	})
	require.NoError(t, err)
	return files
}
