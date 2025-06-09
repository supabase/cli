package deploy

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/cast"
)

func TestDockerBundle(t *testing.T) {
	imageUrl := utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image)
	utils.EdgeRuntimeId = "test-edge-runtime"
	const containerId = "test-container"
	cwd, err := os.Getwd()
	require.NoError(t, err)

	t.Run("throws error on bundle failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		absImportMap := filepath.Join("hello", "deno.json")
		require.NoError(t, utils.WriteFile(absImportMap, []byte("{}"), fsys))
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
		// Setup mock bundler
		bundler := NewDockerBundler(fsys)
		// Run test
		meta, err := bundler.Bundle(
			context.Background(),
			"hello",
			filepath.Join("hello", "index.ts"),
			filepath.Join("hello", "deno.json"),
			[]string{filepath.Join("hello", "data.pdf")},
			&body,
		)
		// Check error
		assert.ErrorContains(t, err, "error running container: exit 1")
		assert.Empty(t, apitest.ListUnmatchedRequests())
		assert.Equal(t, cast.Ptr("hello"), meta.Name)
		entrypoint := fmt.Sprintf("file://%s/hello/index.ts", filepath.ToSlash(cwd))
		assert.Equal(t, entrypoint, meta.EntrypointPath)
		importMap := fmt.Sprintf("file://%s/hello/deno.json", filepath.ToSlash(cwd))
		assert.Equal(t, &importMap, meta.ImportMapPath)
		staticFile := fmt.Sprintf("file://%s/hello/data.pdf", filepath.ToSlash(cwd))
		assert.Equal(t, cast.Ptr([]string{staticFile}), meta.StaticPatterns)
		assert.Nil(t, meta.VerifyJwt)
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup mock bundler
		bundler := NewDockerBundler(fsys)
		// Run test
		meta, err := bundler.Bundle(
			context.Background(),
			"hello",
			"hello/index.ts",
			"",
			nil,
			nil,
		)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
		assert.Equal(t, cast.Ptr("hello"), meta.Name)
		entrypoint := fmt.Sprintf("file://%s/hello/index.ts", filepath.ToSlash(cwd))
		assert.Equal(t, entrypoint, meta.EntrypointPath)
		assert.Nil(t, meta.ImportMapPath)
		assert.NotNil(t, meta.StaticPatterns)
		assert.Nil(t, meta.VerifyJwt)
	})
}
