package start

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
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

func TestStartCommand(t *testing.T) {
	const version = "1.41"

	t.Run("throws error on missing config", func(t *testing.T) {
		err := Run(context.Background(), afero.NewMemMapFs())
		assert.ErrorContains(t, err, "Have you set up the project with supabase init?")
	})

	t.Run("throws error on invalid config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "Failed to read config: toml")
	})

	t.Run("throws error on missing docker", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			ReplyError(errors.New("network error"))
		gock.New("http:///var/run/docker.sock").
			Get("/_ping").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on running database", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "supabase start is already running. Try running supabase stop first.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to create network", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers").
			Reply(http.StatusNotFound)
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/networks/create").
			ReplyError(errors.New("network error"))
		// Cleans up network on error
		gock.New("http:///var/run/docker.sock").
			Delete("/v" + version + "/networks/supabase_network_").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestPullImage(t *testing.T) {
	const version = "1.41"
	const image = "postgres"
	p := utils.NewProgram(model{})

	t.Run("inspects image before pull", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/public.ecr.aws/t3w2s2c9/" + image + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		// Run test
		err := pullImage(p, context.Background(), image)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("pulls missing image", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/public.ecr.aws/t3w2s2c9/" + image + "/json").
			Reply(http.StatusNotFound)
		gock.New("http:///var/run/docker.sock").
			Post("/v"+version+"/images/create").
			MatchParam("fromImage", image).
			MatchParam("tag", "latest").
			Reply(http.StatusAccepted).
			BodyString("progress")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/public.ecr.aws/t3w2s2c9/" + image + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		// Run test
		err := pullImage(p, context.Background(), image)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	// TODO: test for transient error
}

func TestDatabaseStart(t *testing.T) {
	const version = "1.41"
	p := utils.NewProgram(model{})

	t.Run("starts database locally", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/networks/create").
			Reply(http.StatusCreated).
			JSON(types.NetworkCreateResponse{})
		// Caches all dependencies
		utils.DbImage = "postgres"
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/public.ecr.aws/t3w2s2c9/" + utils.DbImage + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		for _, image := range utils.ServiceImages {
			service := filepath.Base(image)
			gock.New("http:///var/run/docker.sock").
				Get("/v" + version + "/images/public.ecr.aws/t3w2s2c9/" + service + "/json").
				Reply(http.StatusOK).
				JSON(types.ImageInspect{})
		}
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/create").
			Reply(http.StatusCreated).
			JSON(container.ContainerCreateCreatedBody{})
		// Run test
		err := run(p, context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "unable to upgrade to tcp, received 404")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestInitDatabase(t *testing.T) {
	const version = "1.41"
	p := utils.NewProgram(model{})

	t.Run("init main branch", func(t *testing.T) {
		utils.DbId = "supabase_db_test"
		utils.Config.Db.Port = 5432
		utils.InitialSchemaSql = "CREATE SCHEMA public"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		globals, err := parser.Split(strings.NewReader(utils.GlobalsSql))
		require.NoError(t, err)
		for _, line := range globals {
			trim := strings.TrimSpace(strings.TrimRight(line, ";"))
			if len(trim) > 0 {
				conn.Query(trim)
			}
		}
		conn.Query(utils.InitialSchemaSql).Reply("CREATE SCHEMA")
		// Run test
		err = initDatabase(p, context.Background(), fsys, conn.Intercept)
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
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Run test
		err := initDatabase(p, context.Background(), fsys)
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
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		globals, err := parser.Split(strings.NewReader(utils.GlobalsSql))
		require.NoError(t, err)
		for _, line := range globals {
			trim := strings.TrimSpace(strings.TrimRight(line, ";"))
			if len(trim) > 0 {
				conn.Query(trim)
			}
		}
		conn.ReplyError(pgerrcode.DuplicateObject, `role "postgres" already exists`)
		// Run test
		err = initDatabase(p, context.Background(), fsys, conn.Intercept)
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
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		globals, err := parser.Split(strings.NewReader(utils.GlobalsSql))
		require.NoError(t, err)
		for _, line := range globals {
			trim := strings.TrimSpace(strings.TrimRight(line, ";"))
			if len(trim) > 0 {
				conn.Query(trim)
			}
		}
		// Run test
		err = initDatabase(p, context.Background(), fsys, conn.Intercept)
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
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		globals, err := parser.Split(strings.NewReader(utils.GlobalsSql))
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
		err = initDatabase(p, context.Background(), fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: database "postgres" already exists (SQLSTATE 42P04)`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
