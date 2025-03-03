package test

import (
	"context"
	"errors"
	"testing"

	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "db.supabase.co",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestRunCommand(t *testing.T) {
	t.Run("runs tests with pg_prove", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ENABLE_PGTAP).
			Reply("CREATE EXTENSION").
			Query(DISABLE_PGTAP).
			Reply("DROP EXTENSION")
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		containerId := "test-pg-prove"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(config.Images.PgProve), containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "Result: SUCCESS"))
		// Run test
		err := Run(context.Background(), []string{"nested"}, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Run test
		err := Run(context.Background(), nil, dbConfig, fsys)
		// Check error
		assert.ErrorContains(t, err, "failed to connect to postgres")
	})

	t.Run("throws error on pgtap failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ENABLE_PGTAP).
			ReplyError(pgerrcode.DuplicateObject, `extension "pgtap" already exists, skipping`)
		// Run test
		err := Run(context.Background(), nil, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "failed to enable pgTAP")
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ENABLE_PGTAP).
			Reply("CREATE EXTENSION").
			Query(DISABLE_PGTAP).
			Reply("DROP EXTENSION")
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(config.Images.PgProve) + "/json").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), nil, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
