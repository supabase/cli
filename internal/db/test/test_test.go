package test

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

var dbConfig = pgconn.Config{
	Host:     "db.supabase.co",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestPgProve(t *testing.T) {
	t.Run("throws error on connect failure", func(t *testing.T) {
		// Run test
		err := pgProve(context.Background(), nil, dbConfig)
		// Check error
		assert.ErrorContains(t, err, "failed to connect to postgres")
	})

	t.Run("throws error on pgtap failure", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ENABLE_PGTAP).
			ReplyError(pgerrcode.DuplicateObject, `extension "pgtap" already exists, skipping`)
		// Run test
		err := pgProve(context.Background(), nil, dbConfig, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "failed to enable pgTAP")
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		errNetwork := errors.New("network error")
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
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.PgProveImage) + "/json").
			ReplyError(errNetwork)
		// Run test
		err := pgProve(context.Background(), nil, dbConfig, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
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
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.PgProveImage), containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "Result: SUCCESS"))
		// Run test
		err := Run(context.Background(), []string{"nested"}, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on missing config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), nil, dbConfig, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}
