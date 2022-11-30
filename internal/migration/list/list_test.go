package list

import (
	"context"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
)

func TestMigrationList(t *testing.T) {
	t.Run("lists remote migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(commit.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := Run(context.Background(), "admin", "password", "postgres", "localhost", fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on remote failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "admin", "password", "postgres", "localhost:0", fsys)
		// Check error
		assert.ErrorContains(t, err, "hostname resolving error (lookup localhost:0: no such host)")
	})

	t.Run("throws error on local failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(commit.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := Run(context.Background(), "admin", "password", "postgres", "localhost", afero.NewReadOnlyFs(fsys), conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})
}

func TestRemoteMigrations(t *testing.T) {
	user := "admin"
	pass := "password"
	host := "localhost"
	db := "postgres"

	t.Run("loads migration versions", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(commit.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"20220727064247"})
		// Run test
		versions, err := loadRemoteMigrations(context.Background(), user, pass, db, host, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"20220727064247"}, versions)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Run test
		_, err := loadRemoteMigrations(context.Background(), user, pass, db, host+":0")
		// Check error
		assert.ErrorContains(t, err, "hostname resolving error (lookup localhost:0: no such host)")
	})

	t.Run("throws error on missing schema", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(commit.LIST_MIGRATION_VERSION).
			ReplyError(pgerrcode.UndefinedTable, "relation \"supabase_migrations.schema_migrations\" does not exist")
		// Run test
		_, err := loadRemoteMigrations(context.Background(), user, pass, db, host, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: relation "supabase_migrations.schema_migrations" does not exist (SQLSTATE 42P01)`)
	})

	t.Run("throws error on invalid row", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(commit.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", nil)
		// Run test
		_, err := loadRemoteMigrations(context.Background(), user, pass, db, host, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "number of field descriptions must equal number of destinations, got 0 and 1")
	})
}

type MockFs struct {
	afero.MemMapFs
	DenyPath string
}

func (m *MockFs) Open(name string) (afero.File, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.Open(name)
}
func TestMakeTable(t *testing.T) {
	t.Run("lists local and remote", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "20220727064246_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte{}, 0644))
		path = filepath.Join(utils.MigrationsDir, "20220727064248_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte{}, 0644))
		// Run test
		_, err := makeTable([]string{"20220727064246", "20220727064247"}, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		_, err := makeTable(nil, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on open failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := MockFs{DenyPath: utils.MigrationsDir}
		// Run test
		_, err := makeTable(nil, &fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
	})
}
