package deploy

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestDeployOne(t *testing.T) {
	const slug = "test-func"
	imageUrl := utils.GetRegistryImageUrl(utils.EdgeRuntimeImage)
	utils.EdgeRuntimeId = "test-edge-runtime"
	const containerId = "test-container"

	t.Run("deploys new function (ESZIP)", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()

		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + project + "/functions").
			ParamPresent("import_map_path").
			ParamPresent("entrypoint_path").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))

		// Setup output file
		outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))

		// Run test
		noVerifyJWT := true
		err := deployOne(context.Background(), slug, project, "", &noVerifyJWT, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("updates deployed function (ESZIP)", func(t *testing.T) {
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
			Patch("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))

		// Setup output file
		outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))

		// Run test
		err = deployOne(context.Background(), slug, project, "", nil, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing import map", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		err := deployOne(context.Background(), slug, project, "import_map.json", nil, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on bundle failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup deno error
		t.Setenv("TEST_DENO_ERROR", "bundle failed")
		var body bytes.Buffer
		archive := zip.NewWriter(&body)
		w, err := archive.Create("deno")
		require.NoError(t, err)
		_, err = w.Write([]byte("binary"))
		require.NoError(t, err)
		require.NoError(t, archive.Close())
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://github.com").
			Get("/denoland/deno/releases/download/v" + utils.DenoVersion).
			Reply(http.StatusOK).
			Body(&body)

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogsExitCode(utils.Docker, containerId, 1))

		// Run test
		err = deployOne(context.Background(), slug, project, "", nil, fsys)
		// Check error
		assert.ErrorContains(t, err, "error running container: exit 1")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestDeployAll(t *testing.T) {
	const slug = "test-func"
	imageUrl := utils.GetRegistryImageUrl(utils.EdgeRuntimeImage)
	utils.EdgeRuntimeId = "test-edge-runtime"
	const containerId = "test-container"

	t.Run("deploys multiple functions", func(t *testing.T) {
		functions := []string{slug, slug + "-2"}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		// Setup mock api
		defer gock.OffAll()
		for i := range functions {
			// Do not match slug to avoid flakey tests
			gock.New(utils.DefaultApiHost).
				Get("/v1/projects/" + project + "/functions/").
				Reply(http.StatusNotFound)
			gock.New(utils.DefaultApiHost).
				Post("/v1/projects/" + project + "/functions").
				Reply(http.StatusCreated).
				JSON(api.FunctionResponse{Id: fmt.Sprintf("%d", i)})

			// Setup mock docker
			require.NoError(t, apitest.MockDocker(utils.Docker))
			apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
			require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))
		}

		// Setup output file
		for _, v := range functions {
			outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", v))
			require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))
		}

		// Run test
		noVerifyJWT := true
		err := deployAll(context.Background(), functions, project, "", &noVerifyJWT, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to install deno", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		err := deployAll(context.Background(), []string{slug}, project, "", nil, fsys)
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
		err = deployAll(context.Background(), []string{slug}, project, "", nil, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})
}

func TestDeployCommand(t *testing.T) {
	const slug = "test-func"
	imageUrl := utils.GetRegistryImageUrl(utils.EdgeRuntimeImage)
	utils.EdgeRuntimeId = "test-edge-runtime"
	const containerId = "test-container"

	t.Run("deploys multiple functions", func(t *testing.T) {
		functions := []string{slug, slug + "-2"}
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
		for i := range functions {
			// Do not match slug to avoid flakey tests
			gock.New(utils.DefaultApiHost).
				Get("/v1/projects/" + project + "/functions/").
				Reply(http.StatusNotFound)
			gock.New(utils.DefaultApiHost).
				Post("/v1/projects/" + project + "/functions").
				Reply(http.StatusCreated).
				JSON(api.FunctionResponse{Id: fmt.Sprintf("%d", i)})

				// Setup mock docker
			require.NoError(t, apitest.MockDocker(utils.Docker))
			apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
			require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))
		}

		// Setup output file
		for _, v := range functions {
			outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", v))
			require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))
		}

		// Run test
		noVerifyJWT := true
		err = Run(context.Background(), functions, project, &noVerifyJWT, "", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("deploys functions from directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		importMapPath, err := filepath.Abs(utils.FallbackImportMapPath)
		require.NoError(t, err)
		require.NoError(t, afero.WriteFile(fsys, importMapPath, []byte("{}"), 0644))
		// Setup function entrypoint
		entrypointPath := filepath.Join(utils.FunctionsDir, slug, "index.ts")
		require.NoError(t, afero.WriteFile(fsys, entrypointPath, []byte{}, 0644))
		ignorePath := filepath.Join(utils.FunctionsDir, "_ignore", "index.ts")
		require.NoError(t, afero.WriteFile(fsys, ignorePath, []byte{}, 0644))
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err = fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/"+project+"/functions").
			MatchParam("slug", slug).
			ParamPresent("import_map_path").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))

		// Setup output file
		outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))

		// Run test
		err = Run(context.Background(), nil, project, nil, "", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), []string{"_invalid"}, "", nil, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid Function name.")
	})

	t.Run("throws error on empty functions", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, fsys.MkdirAll(utils.FunctionsDir, 0755))
		// Run test
		err := Run(context.Background(), nil, "", nil, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "No Functions specified or found in supabase/functions")
	})

	t.Run("verify_jwt param falls back to config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		f, err := fsys.OpenFile("supabase/config.toml", os.O_APPEND|os.O_WRONLY, 0600)
		require.NoError(t, err)
		_, err = f.WriteString(`
[functions.` + slug + `]
verify_jwt = false
`)
		require.NoError(t, err)
		require.NoError(t, f.Close())
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err = fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/"+project+"/functions").
			MatchParam("verify_jwt", "false").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))

		// Setup output file
		outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))

		// Run test
		assert.NoError(t, Run(context.Background(), []string{slug}, project, nil, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("verify_jwt flag overrides config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		f, err := fsys.OpenFile("supabase/config.toml", os.O_APPEND|os.O_WRONLY, 0600)
		require.NoError(t, err)
		_, err = f.WriteString(`
[functions.` + slug + `]
verify_jwt = false
`)
		require.NoError(t, err)
		require.NoError(t, f.Close())
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err = fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/"+project+"/functions").
			MatchParam("verify_jwt", "true").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))

		// Setup output file
		outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))

		// Run test
		noVerifyJwt := false
		assert.NoError(t, Run(context.Background(), []string{slug}, project, &noVerifyJwt, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestDeployFunction(t *testing.T) {
	const slug = "test-func"
	// Setup valid project ref
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	utils.EdgeRuntimeId = "test-edge-runtime"

	t.Run("throws error on network failure", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			ReplyError(errors.New("network error"))
		// Run test
		err := deployFunction(context.Background(), project, slug, "", "", true, strings.NewReader("body"))
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := deployFunction(context.Background(), project, slug, "", "", true, strings.NewReader("body"))
		// Check error
		assert.ErrorContains(t, err, "Unexpected error deploying Function:")
	})

	t.Run("throws error on create failure", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + project + "/functions").
			ReplyError(errors.New("network error"))
		// Run test
		err := deployFunction(context.Background(), project, slug, "", "", true, strings.NewReader("body"))
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on create unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + project + "/functions").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := deployFunction(context.Background(), project, slug, "", "", true, strings.NewReader("body"))
		// Check error
		assert.ErrorContains(t, err, "Failed to create a new Function on the Supabase project:")
	})

	t.Run("throws error on update failure", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Patch("/v1/projects/" + project + "/functions/" + slug).
			ReplyError(errors.New("network error"))
		// Run test
		err := deployFunction(context.Background(), project, slug, "", "", true, strings.NewReader("body"))
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on update unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Patch("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := deployFunction(context.Background(), project, slug, "", "", true, strings.NewReader("body"))
		// Check error
		assert.ErrorContains(t, err, "Failed to update an existing Function's body on the Supabase project:")
	})
}
