package start

import (
	"context"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
	"gopkg.in/h2non/gock.v1"
)

func TestInitDatabase(t *testing.T) {
	t.Run("init main branch", func(t *testing.T) {
		utils.DbId = "supabase_db_test"
		utils.Config.Db.Port = 5432
		utils.InitialSchemaSql = "CREATE SCHEMA public"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		globals, err := parser.SplitAndTrim(strings.NewReader(utils.GlobalsSql))
		require.NoError(t, err)
		for _, line := range globals {
			trim := strings.TrimSpace(strings.TrimRight(line, ";"))
			if len(trim) > 0 {
				conn.Query(trim)
			}
		}
		conn.Query(utils.InitialSchemaSql).Reply("CREATE SCHEMA")
		// Run test
		err = initDatabase(context.Background(), fsys, io.Discard, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Check current branch
		contents, err := afero.ReadFile(fsys, utils.CurrBranchPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte("main"), contents)
		// Check branch dir
		branchPath := filepath.Join(filepath.Dir(utils.CurrBranchPath), "main")
		exists, err := afero.DirExists(fsys, branchPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Check migrations
		exists, err = afero.DirExists(fsys, utils.MigrationsDir)
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		utils.DbId = "supabase_db_test"
		utils.Config.Db.Port = 0
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Run test
		err := initDatabase(context.Background(), fsys, io.Discard)
		// Check error
		assert.ErrorContains(t, err, "invalid port")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on exec failure", func(t *testing.T) {
		utils.DbId = "supabase_db_test"
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		globals, err := parser.SplitAndTrim(strings.NewReader(utils.GlobalsSql))
		require.NoError(t, err)
		for _, line := range globals {
			trim := strings.TrimSpace(strings.TrimRight(line, ";"))
			if len(trim) > 0 {
				conn.Query(trim)
			}
		}
		conn.ReplyError(pgerrcode.DuplicateObject, `role "postgres" already exists`)
		// Run test
		err = initDatabase(context.Background(), fsys, io.Discard, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: role "postgres" already exists (SQLSTATE 42710)`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		utils.DbId = "supabase_db_test"
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		globals, err := parser.SplitAndTrim(strings.NewReader(utils.GlobalsSql))
		require.NoError(t, err)
		for _, line := range globals {
			trim := strings.TrimSpace(strings.TrimRight(line, ";"))
			if len(trim) > 0 {
				conn.Query(trim)
			}
		}
		// Run test
		err = initDatabase(context.Background(), fsys, io.Discard, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("restore dumped branches", func(t *testing.T) {
		utils.DbId = "supabase_db_test"
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.CurrBranchPath, []byte("develop"), 0644))
		branchDir := filepath.Dir(utils.CurrBranchPath)
		dumpPath := filepath.Join(branchDir, "develop", "dump.sql")
		dumpSql := "CREATE SCHEMA public"
		require.NoError(t, afero.WriteFile(fsys, dumpPath, []byte(dumpSql), 0644))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(branchDir, "postgres", "dump.sql"), []byte(dumpSql), 0644))
		require.NoError(t, fsys.Mkdir(filepath.Join(branchDir, "invalid"), 0755))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		globals, err := parser.SplitAndTrim(strings.NewReader(utils.GlobalsSql))
		require.NoError(t, err)
		for _, line := range globals {
			trim := strings.TrimSpace(strings.TrimRight(line, ";"))
			if len(trim) > 0 {
				conn.Query(trim)
			}
		}
		conn.Query(dumpSql).
			Reply("CREATE SCHEMA").
			Query(`CREATE DATABASE "postgres";`).
			ReplyError(pgerrcode.DuplicateDatabase, `database "postgres" already exists`)
		// Run test
		err = initDatabase(context.Background(), fsys, io.Discard, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: database "postgres" already exists (SQLSTATE 42P04)`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
