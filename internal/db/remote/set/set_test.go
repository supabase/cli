package set

import (
	"testing"

	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
)

func TestDbRemoteSetCommand(t *testing.T) {
	const postgresUrl = "postgresql://postgres:password@localhost:5432/postgres"

	t.Run("sets the remote database url", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup initial migration
		version := "20220727064247"
		_, err := fsys.Create("supabase/migrations/" + version + "_init.sql")
		require.NoError(t, err)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close()
		conn.Query(CHECK_MIGRATION_EXISTS).
			Reply("SELECT 0").
			Query(LIST_MIGRATION_VERSION).
			Reply("SELECT 1", map[string]interface{}{"version": version})
		// Run test
		assert.NoError(t, Run(postgresUrl, fsys, conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
	})

	t.Run("creates migrations table if absent", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close()
		conn.Query(CHECK_MIGRATION_EXISTS).
			ReplyError(pgerrcode.UndefinedTable, "relation \"supabase_migrations.schema_migrations\" does not exist").
			Query(CREATE_MIGRATION_TABLE).
			Reply("CREATE TABLE").
			Query(LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		assert.NoError(t, Run(postgresUrl, fsys, conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
		// Validate file contents
		content, err := afero.ReadFile(fsys, utils.RemoteDbPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte(postgresUrl), content)
	})

	t.Run("throws error on missing config file", func(t *testing.T) {
		assert.Error(t, Run("", afero.NewMemMapFs()))
	})

	t.Run("throws error on invalid postgres url", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Run test
		assert.Error(t, Run("invalid", fsys))
	})

	t.Run("throws error on failture to connect", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup mock postgres
		conn := pgtest.NewWithStatus(map[string]string{})
		defer conn.Close()
		// Run test
		assert.Error(t, Run(postgresUrl, fsys, conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
	})

	t.Run("throws error on missing server version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup mock postgres
		conn := pgtest.NewWithStatus(map[string]string{
			"standard_conforming_strings": "on",
		})
		defer conn.Close()
		// Run test
		assert.Error(t, Run(postgresUrl, fsys, conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
	})

	t.Run("throws error on unsupported server version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup mock postgres
		conn := pgtest.NewWithStatus(map[string]string{
			"standard_conforming_strings": "on",
			"server_version":              "13.1",
		})
		defer conn.Close()
		// Run test
		assert.Error(t, Run(postgresUrl, fsys, conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
	})

	t.Run("throws error on failure to create table", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close()
		conn.Query(CHECK_MIGRATION_EXISTS).
			ReplyError(pgerrcode.UndefinedTable, "relation \"supabase_migrations.schema_migrations\" does not exist").
			Query(CREATE_MIGRATION_TABLE).
			ReplyError(pgerrcode.DuplicateTable, "relation \"schema_migrations\" already exists")
		// Run test
		assert.Error(t, Run(postgresUrl, fsys, conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
	})

	t.Run("throws error on failure to list migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close()
		conn.Query(CHECK_MIGRATION_EXISTS).
			Reply("SELECT 0").
			Query(LIST_MIGRATION_VERSION).
			ReplyError(pgerrcode.UndefinedTable, "relation \"supabase_migrations.schema_migrations\" does not exist")
		// Run test
		assert.Error(t, Run(postgresUrl, fsys, conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
	})

	t.Run("throws error on migration mismatch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close()
		conn.Query(CHECK_MIGRATION_EXISTS).
			Reply("SELECT 0").
			Query(LIST_MIGRATION_VERSION).
			Reply("SELECT 1", map[string]interface{}{"version": "20220727064247"})
		// Run test
		assert.Error(t, Run(postgresUrl, fsys, conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
	})

	t.Run("throws error on malformed file name", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup initial migration
		version := "20220727064247"
		_, err := fsys.Create("supabase/migrations/" + version + ".sql")
		require.NoError(t, err)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close()
		conn.Query(CHECK_MIGRATION_EXISTS).
			Reply("SELECT 0").
			Query(LIST_MIGRATION_VERSION).
			Reply("SELECT 1", map[string]interface{}{"version": "20220727064247"})
		// Run test
		assert.Error(t, Run(postgresUrl, fsys, conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
	})

	t.Run("throws error on failure to create directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, true))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close()
		conn.Query(CHECK_MIGRATION_EXISTS).
			ReplyError(pgerrcode.UndefinedTable, "relation \"supabase_migrations.schema_migrations\" does not exist").
			Query(CREATE_MIGRATION_TABLE).
			Reply("CREATE TABLE").
			Query(LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		assert.Error(t, Run(postgresUrl, afero.NewReadOnlyFs(fsys), conn.Intercept))
		assert.NoError(t, <-conn.ErrChan)
	})
}
