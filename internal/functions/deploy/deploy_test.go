package deploy

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func init() {
	// Setup fake deno binary
	if denoPath, err := os.Executable(); err == nil {
		utils.DenoPathOverride = denoPath
	}
}

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && (os.Args[1] == "bundle" || os.Args[1] == "upgrade") {
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestDeployCommand(t *testing.T) {
	t.Run("deploys new function", func(t *testing.T) {
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
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/test-func").
			Reply(http.StatusNotFound)
		gock.New("https://api.supabase.io").
			Post("/v1/projects/" + project + "/functions").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		assert.NoError(t, Run(context.Background(), "test-func", project, false, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("updates deployed function", func(t *testing.T) {
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
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/test-func").
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New("https://api.supabase.io").
			Patch("/v1/projects/" + project + "/functions").
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		assert.NoError(t, Run(context.Background(), "test-func", project, false, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
