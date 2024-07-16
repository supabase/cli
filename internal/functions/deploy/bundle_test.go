package deploy

import (
	"archive/zip"
	"bytes"
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
)

func TestDockerBundle(t *testing.T) {
	imageUrl := utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image)
	utils.EdgeRuntimeId = "test-edge-runtime"
	const containerId = "test-container"

	t.Run("throws error on bundle failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
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
		err = NewDockerBundler(fsys).Bundle(context.Background(), "", "", &body)
		// Check error
		assert.ErrorContains(t, err, "error running container: exit 1")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
