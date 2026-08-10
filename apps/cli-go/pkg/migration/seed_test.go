package migration

import (
	"context"
	_ "embed"
	"os"
	"testing"
	fs "testing/fstest"

	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/pgtest"
)

//go:embed testdata/seed.sql
var testSeed string

func TestPendingSeeds(t *testing.T) {
	pending := []string{"testdata/seed.sql"}

	t.Run("finds new seeds", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(SELECT_SEED_TABLE).
			Reply("SELECT 0")
		// Run test
		seeds, err := GetPendingSeeds(context.Background(), pending, conn.MockClient(t), testMigrations)
		// Check error
		assert.NoError(t, err)
		require.Len(t, seeds, 1)
		assert.Equal(t, seeds[0].Path, pending[0])
		assert.Equal(t, seeds[0].Hash, "61868484fc0ddca2a2022217629a9fd9a4cf1ca479432046290797d6d40ffcc3")
		assert.False(t, seeds[0].Dirty)
	})

	t.Run("finds dirty seeds", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(SELECT_SEED_TABLE).
			Reply("SELECT 1", SeedFile{Path: pending[0], Hash: "outdated"})
		// Run test
		seeds, err := GetPendingSeeds(context.Background(), pending, conn.MockClient(t), testMigrations)
		// Check error
		assert.NoError(t, err)
		require.Len(t, seeds, 1)
		assert.Equal(t, seeds[0].Path, pending[0])
		assert.Equal(t, seeds[0].Hash, "61868484fc0ddca2a2022217629a9fd9a4cf1ca479432046290797d6d40ffcc3")
		assert.True(t, seeds[0].Dirty)
	})

	t.Run("skips applied seed", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(SELECT_SEED_TABLE).
			Reply("SELECT 1", SeedFile{Path: pending[0], Hash: "61868484fc0ddca2a2022217629a9fd9a4cf1ca479432046290797d6d40ffcc3"})
		// Run test
		seeds, err := GetPendingSeeds(context.Background(), pending, conn.MockClient(t), testMigrations)
		// Check error
		assert.NoError(t, err)
		require.Empty(t, seeds)
	})

	t.Run("ignores missing seed table", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(SELECT_SEED_TABLE).
			ReplyError(pgerrcode.UndefinedTable, `relation "seed_files" does not exist`)
		// Run test
		_, err := GetPendingSeeds(context.Background(), pending, conn.MockClient(t), testMigrations)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("ignores missing seed file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{}
		// Run test
		_, err := GetPendingSeeds(context.Background(), pending, nil, fsys)
		// Check error
		assert.NoError(t, err)
	})
}

func TestSeedData(t *testing.T) {
	t.Run("seeds from file", func(t *testing.T) {
		seed := SeedFile{
			Path:  "testdata/seed.sql",
			Hash:  "61868484fc0ddca2a2022217629a9fd9a4cf1ca479432046290797d6d40ffcc3",
			Dirty: true,
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		mockSeedHistory(conn).
			Query(UPSERT_SEED_FILE, seed.Path, seed.Hash).
			Reply("INSERT 0 1")
		// Run test
		err := SeedData(context.Background(), []SeedFile{seed}, conn.MockClient(t), testMigrations)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on upsert failure", func(t *testing.T) {
		seed := SeedFile{
			Path: "testdata/seed.sql",
			Hash: "61868484fc0ddca2a2022217629a9fd9a4cf1ca479432046290797d6d40ffcc3",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		mockSeedHistory(conn).
			Query(testSeed+`;INSERT INTO supabase_migrations.seed_files(path, hash) VALUES( 'testdata/seed.sql' ,  '61868484fc0ddca2a2022217629a9fd9a4cf1ca479432046290797d6d40ffcc3' ) ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash`).
			ReplyError(pgerrcode.NotNullViolation, `null value in column "age" of relation "employees"`)
		// Run test
		err := SeedData(context.Background(), []SeedFile{seed}, conn.MockClient(t, func(cc *pgx.ConnConfig) {
			cc.PreferSimpleProtocol = true
		}), testMigrations)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "age" of relation "employees" (SQLSTATE 23502)`)
	})
}

func mockSeedHistory(conn *pgtest.MockConn) *pgtest.MockConn {
	conn.Query(SET_LOCK_TIMEOUT).
		Query(CREATE_VERSION_SCHEMA).
		Reply("CREATE SCHEMA").
		Query(CREATE_SEED_TABLE).
		Reply("CREATE TABLE")
	return conn
}

//go:embed testdata/1_globals.sql
var testGlobals string

func TestSeedGlobals(t *testing.T) {
	pending := []string{"testdata/1_globals.sql"}

	t.Run("seeds from file", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(testGlobals).
			Reply("CREATE ROLE")
		// Run test
		err := SeedGlobals(context.Background(), pending, conn.MockClient(t), testMigrations)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{}
		// Run test
		err := SeedGlobals(context.Background(), pending, nil, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on create failure", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(testGlobals).
			ReplyError(pgerrcode.InvalidCatalogName, `database "postgres" does not exist`)
		// Run test
		err := SeedGlobals(context.Background(), pending, conn.MockClient(t), testMigrations)
		// Check error
		assert.ErrorContains(t, err, `ERROR: database "postgres" does not exist (SQLSTATE 3D000)`)
	})
}
