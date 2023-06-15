package start

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/volume"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestInitBranch(t *testing.T) {
	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		err := initCurrentBranch(fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on stat failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.StatErrorFs{DenyPath: utils.CurrBranchPath}
		// Run test
		err := initCurrentBranch(fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.CurrBranchPath}
		// Run test
		err := initCurrentBranch(fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
	})
}

func TestInitDatabase(t *testing.T) {
	t.Run("throws error on connect failure", func(t *testing.T) {
		utils.Config.Db.Port = 0
		// Run test
		err := initDatabase(context.Background(), io.Discard)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on exec failure", func(t *testing.T) {
		utils.Config.Db.Port = 5432
		utils.GlobalsSql = "create role postgres"
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			ReplyError(pgerrcode.DuplicateObject, `role "postgres" already exists`)
		// Run test
		err := initDatabase(context.Background(), io.Discard, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: role "postgres" already exists (SQLSTATE 42710)`)
	})
}

func TestStartDatabase(t *testing.T) {
	teardown := func() {
		utils.Containers = []string{}
		utils.Volumes = []string{}
	}

	t.Run("initialise main branch", func(t *testing.T) {
		defer teardown()
		utils.DbImage = utils.Pg15Image
		utils.Config.Db.MajorVersion = 15
		utils.DbId = "supabase_db_test"
		utils.ConfigId = "supabase_config_test"
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusNotFound).
			JSON(volume.Volume{})
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.DbImage), utils.DbId)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})
		// Run test
		err := StartDatabase(context.Background(), fsys, io.Discard)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Check current branch
		contents, err := afero.ReadFile(fsys, utils.CurrBranchPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte("main"), contents)
	})

	t.Run("recover from backup volume", func(t *testing.T) {
		defer teardown()
		utils.DbImage = utils.Pg15Image
		utils.Config.Db.MajorVersion = 15
		utils.DbId = "supabase_db_test"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusOK).
			JSON(volume.Volume{})
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.DbImage), utils.DbId)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})
		// Run test
		err := StartDatabase(context.Background(), fsys, io.Discard)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Check current branch
		contents, err := afero.ReadFile(fsys, utils.CurrBranchPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte("main"), contents)
	})

	t.Run("throws error on start failure", func(t *testing.T) {
		defer teardown()
		utils.DbImage = utils.Pg15Image
		utils.Config.Db.MajorVersion = 15
		utils.DbId = "supabase_db_test"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			ReplyError(errors.New("network error"))
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.DbImage) + "/json").
			Reply(http.StatusInternalServerError)
		// Run test
		err := StartDatabase(context.Background(), fsys, io.Discard)
		// Check error
		assert.ErrorContains(t, err, "request returned Internal Server Error for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestStartCommand(t *testing.T) {
	t.Run("throws error on missing config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on missing docker", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Head("/_ping").
			ReplyError(errors.New("network error"))
		gock.New(utils.Docker.DaemonHost()).
			Get("/_ping").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("exits if already started", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", utils.Docker.ClientVersion()).
			SetHeader("OSType", "linux")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on start failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", utils.Docker.ClientVersion()).
			SetHeader("OSType", "linux")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusNotFound)
		// Fail to start
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			ReplyError(errors.New("network error"))
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Pg15Image) + "/json").
			ReplyError(errors.New("network error"))
		// Cleanup resources
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/networks/").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestSetupDatabase(t *testing.T) {
	config := pgconn.Config{Host: utils.DbId}

	t.Run("skips when backup exists", func(t *testing.T) {
		noBackupVolume = false
		// Run test
		err := SetupDatabase(context.Background(), config, nil, io.Discard)
		// Check error
		assert.NoError(t, err)
		// Reset variable
		noBackupVolume = true
	})

	t.Run("initialises database", func(t *testing.T) {
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		err := SetupDatabase(context.Background(), config, fsys, io.Discard, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		utils.Config.Db.Port = 0
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.CustomRolesPath}
		// Run test
		err := SetupDatabase(context.Background(), config, fsys, io.Discard)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on read failure", func(t *testing.T) {
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.CustomRolesPath}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		err := SetupDatabase(context.Background(), config, fsys, io.Discard, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on exec failure", func(t *testing.T) {
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		sql := "create role postgres"
		require.NoError(t, afero.WriteFile(fsys, utils.CustomRolesPath, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(sql).
			ReplyError(pgerrcode.DuplicateObject, `role "postgres" already exists`)
		// Run test
		err := SetupDatabase(context.Background(), config, fsys, io.Discard, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: role "postgres" already exists (SQLSTATE 42710)`)
	})
}
