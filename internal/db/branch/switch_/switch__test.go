package switch_

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestSwitchCommand(t *testing.T) {
	t.Run("switches local branch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup target branch
		branch := "target"
		branchPath := filepath.Join(filepath.Dir(utils.CurrBranchPath), branch)
		require.NoError(t, fsys.Mkdir(branchPath, 0755))
		require.NoError(t, afero.WriteFile(fsys, utils.CurrBranchPath, []byte("main"), 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusServiceUnavailable)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			Reply("ALTER DATABASE").
			Query(fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres")).
			Reply("DO").
			Query("ALTER DATABASE postgres RENAME TO main;").
			Reply("ALTER DATABASE").
			Query("ALTER DATABASE " + branch + " RENAME TO postgres;").
			Reply("ALTER DATABASE")
		// Run test
		assert.NoError(t, Run(context.Background(), branch, fsys, conn.Intercept))
		// Validate output
		assert.Empty(t, apitest.ListUnmatchedRequests())
		contents, err := afero.ReadFile(fsys, utils.CurrBranchPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte(branch), contents)
	})

	t.Run("throws error on missing config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "target", fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), "target", fsys)
		// Check error
		assert.ErrorContains(t, err, "toml: line 0: unexpected EOF; expected key separator '='")
	})

	t.Run("throws error on missing database", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusNotFound)
		// Run test
		err := Run(context.Background(), "target", fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotRunning)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on reserved branch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Run test
		err := Run(context.Background(), "postgres", fsys)
		// Check error
		assert.ErrorContains(t, err, "branch name is reserved.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing branch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Run test
		err := Run(context.Background(), "main", fsys)
		// Check error
		assert.ErrorContains(t, err, "Branch main does not exist.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("noop on current branch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Setup target branch
		branch := "main"
		branchPath := filepath.Join(filepath.Dir(utils.CurrBranchPath), branch)
		require.NoError(t, fsys.Mkdir(branchPath, 0755))
		// Run test
		assert.NoError(t, Run(context.Background(), branch, fsys))
		// Check error
		assert.Empty(t, apitest.ListUnmatchedRequests())
		contents, err := afero.ReadFile(fsys, utils.CurrBranchPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte(branch), contents)
	})

	t.Run("throws error on failure to switch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Setup target branch
		branch := "target"
		branchPath := filepath.Join(filepath.Dir(utils.CurrBranchPath), branch)
		require.NoError(t, fsys.Mkdir(branchPath, 0755))
		// Setup mock postgres
		conn := pgtest.NewConn()
		// Run test
		err := Run(context.Background(), branch, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "Error switching to branch target")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to write", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Setup target branch
		branch := "main"
		branchPath := filepath.Join(filepath.Dir(utils.CurrBranchPath), branch)
		require.NoError(t, fsys.Mkdir(branchPath, 0755))
		// Run test
		err := Run(context.Background(), branch, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "Unable to update local branch file.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestSwitchDatabase(t *testing.T) {
	t.Run("throws error on failure to connect", func(t *testing.T) {
		// Setup invalid port
		utils.Config.Db.Port = 0
		// Run test
		err := switchDatabase(context.Background(), "main", "target")
		// Check error
		assert.ErrorContains(t, err, "invalid port")
	})

	t.Run("throws error on failure to disconnect", func(t *testing.T) {
		// Setup valid config
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			ReplyError(pgerrcode.InvalidParameterValue, `cannot disallow connections for current database`)
		// Run test
		err := switchDatabase(context.Background(), "main", "target", conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, pgerrcode.InvalidParameterValue)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to backup", func(t *testing.T) {
		// Setup valid config
		utils.DbId = "test-switch"
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			Reply("ALTER DATABASE").
			Query(fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres")).
			Reply("DO").
			Query("ALTER DATABASE postgres RENAME TO main;").
			ReplyError(pgerrcode.DuplicateDatabase, `database "main" already exists`)
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/restart").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := switchDatabase(context.Background(), "main", "target", conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, pgerrcode.DuplicateDatabase)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to rename", func(t *testing.T) {
		// Setup valid config
		utils.DbId = "test-switch"
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			Reply("ALTER DATABASE").
			Query(fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres")).
			Reply("DO").
			Query("ALTER DATABASE postgres RENAME TO main;").
			Reply("ALTER DATABASE").
			Query("ALTER DATABASE target RENAME TO postgres;").
			ReplyError(pgerrcode.InvalidCatalogName, `database "target" does not exist`).
			// Attempt to rollback
			Query("ALTER DATABASE main RENAME TO postgres;").
			ReplyError(pgerrcode.DuplicateDatabase, `database "postgres" already exists`)
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/restart").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := switchDatabase(context.Background(), "main", "target", conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, pgerrcode.InvalidCatalogName)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
