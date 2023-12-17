package create

import (
	"context"
	"net"
	"net/http"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestCreateCommand(t *testing.T) {
	t.Run("creates preview branch", func(t *testing.T) {
		// Setup valid project ref
		ref := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(ref), 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + ref + "/branches").
			Reply(http.StatusCreated).
			JSON(api.BranchResponse{
				Id: "test-uuid",
			})
		// Run test
		err := Run(context.Background(), "", "sin", fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.ProjectRefPath}
		// Run test
		err := Run(context.Background(), "branch", "region", fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on network disconnected", func(t *testing.T) {
		ref := apitest.RandomProjectRef()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(ref), 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + ref + "/branches").
			ReplyError(net.ErrClosed)
		// Run test
		err := Run(context.Background(), "", "sin", fsys)
		// Check error
		assert.ErrorIs(t, err, net.ErrClosed)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		ref := apitest.RandomProjectRef()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(ref), 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + ref + "/branches").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), "", "sin", fsys)
		// Check error
		assert.ErrorContains(t, err, "Unexpected error creating preview branch:")
	})
}
