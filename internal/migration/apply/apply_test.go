package apply

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
)

func TestMigrateDatabase(t *testing.T) {
	t.Run("applies local migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		sql := "create schema public"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(repair.ADD_NAME_COLUMN).
			Reply("ALTER TABLE").
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(repair.INSERT_MIGRATION_VERSION, "0", "test", fmt.Sprintf("{%s}", sql)).
			Reply("INSERT 1")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = MigrateAndSeed(ctx, "", mock, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("ignores empty local directory", func(t *testing.T) {
		assert.NoError(t, MigrateAndSeed(context.Background(), "", nil, afero.NewMemMapFs()))
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := MigrateAndSeed(context.Background(), "", nil, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})
}

func TestSeedDatabase(t *testing.T) {
	t.Run("seeds from file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup seed file
		sql := "INSERT INTO employees(name) VALUES ('Alice')"
		require.NoError(t, afero.WriteFile(fsys, utils.SeedDataPath, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(sql).
			Reply("INSERT 0 1")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		assert.NoError(t, SeedDatabase(ctx, mock, fsys))
	})

	t.Run("ignores missing seed", func(t *testing.T) {
		assert.NoError(t, SeedDatabase(context.Background(), nil, afero.NewMemMapFs()))
	})

	t.Run("throws error on read failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.SeedDataPath}
		// Run test
		err := SeedDatabase(context.Background(), nil, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on insert failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup seed file
		sql := "INSERT INTO employees(name) VALUES ('Alice')"
		require.NoError(t, afero.WriteFile(fsys, utils.SeedDataPath, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(sql).
			ReplyError(pgerrcode.NotNullViolation, `null value in column "age" of relation "employees"`)
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = SeedDatabase(ctx, mock, fsys)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "age" of relation "employees" (SQLSTATE 23502)`)
	})
}

func TestMigrateUp(t *testing.T) {
	t.Run("throws error on exec failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Query(repair.ADD_NAME_COLUMN)
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = MigrateUp(context.Background(), mock, []string{"20220727064247_employees.sql"}, fsys)
		// Check error
		assert.ErrorContains(t, err, "ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)")
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(repair.ADD_NAME_COLUMN).
			Reply("ALTER TABLE")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = MigrateUp(context.Background(), mock, []string{"20220727064247_missing.sql"}, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}
