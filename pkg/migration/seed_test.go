package migration

import (
	"context"
	_ "embed"
	"os"
	"testing"
	fs "testing/fstest"

	"github.com/jackc/pgerrcode"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/pgtest"
)

//go:embed testdata/seed.sql
var testSeed string

func TestSeedData(t *testing.T) {
	pending := []string{"testdata/seed.sql"}

	t.Run("seeds from file", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(testSeed).
			Reply("INSERT 0 1")
		// Run test
		err := SeedData(context.Background(), pending, conn.MockClient(t), testMigrations)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{}
		// Run test
		err := SeedData(context.Background(), pending, nil, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on insert failure", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(testSeed).
			ReplyError(pgerrcode.NotNullViolation, `null value in column "age" of relation "employees"`)
		// Run test
		err := SeedData(context.Background(), pending, conn.MockClient(t), testMigrations)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "age" of relation "employees" (SQLSTATE 23502)`)
	})
}

//go:embed testdata/globals.sql
var testGlobals string

func TestSeedGlobals(t *testing.T) {
	pending := []string{"testdata/globals.sql"}

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
