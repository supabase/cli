package create

import (
	"context"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestBranchValidation(t *testing.T) {
	t.Run("branch name is valid", func(t *testing.T) {
		assert.NoError(t, assertNewBranchIsValid("test-branch", afero.NewMemMapFs()))
	})

	t.Run("branch name is reserved", func(t *testing.T) {
		assert.Error(t, assertNewBranchIsValid("main", afero.NewMemMapFs()))
	})

	t.Run("branch name is invalid", func(t *testing.T) {
		assert.Error(t, assertNewBranchIsValid("@", afero.NewMemMapFs()))
	})

	t.Run("branch not a directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := "/supabase/.branches/test-branch"
		_, err := fsys.Create(path)
		require.NoError(t, err)
		// Run test
		assert.Error(t, assertNewBranchIsValid(path, fsys))
	})

	t.Run("branch already exists", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := "/supabase/.branches/test-branch"
		require.NoError(t, fsys.MkdirAll(path, 0755))
		// Run test
		assert.Error(t, assertNewBranchIsValid(path, fsys))
	})
}

func TestBranchCreation(t *testing.T) {
	utils.DbId = "test-db"

	t.Run("docker exec failure", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/exec").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := createBranch(context.Background(), "test-branch")
		// Validate api
		assert.ErrorContains(t, err, "request returned Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("docker attach failure", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/exec").
			Reply(http.StatusCreated).
			JSON(types.ContainerJSON{})
		// Run test
		err := createBranch(context.Background(), "test-branch")
		// Validate api
		assert.ErrorContains(t, err, "cannot connect to the Docker daemon.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestCreateCommand(t *testing.T) {
	const branch = "test-branch"

	t.Run("throws error on missing config", func(t *testing.T) {
		assert.Error(t, Run(branch, afero.NewMemMapFs()))
	})

	t.Run("throws error on stopped db", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(branch, fsys)
		// Validate api
		assert.ErrorIs(t, err, utils.ErrNotRunning)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
