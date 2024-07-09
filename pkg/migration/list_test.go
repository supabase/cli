package migration

import (
	"context"
	"testing"
	fs "testing/fstest"

	"github.com/jackc/pgerrcode"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestRemoteMigrations(t *testing.T) {
	t.Run("loads migration versions", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"20220727064247"})
		// Run test
		versions, err := ListRemoteMigrations(context.Background(), conn.MockClient(t))
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"20220727064247"}, versions)
	})

	t.Run("loads empty migrations on missing table", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(LIST_MIGRATION_VERSION).
			ReplyError(pgerrcode.UndefinedTable, "relation \"supabase_migrations.schema_migrations\" does not exist")
		// Run test
		versions, err := ListRemoteMigrations(context.Background(), conn.MockClient(t))
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, versions)
	})

	t.Run("throws error on invalid row", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{})
		// Run test
		_, err := ListRemoteMigrations(context.Background(), conn.MockClient(t))
		// Check error
		assert.ErrorContains(t, err, "number of field descriptions must equal number of destinations, got 0 and 1")
	})
}

func TestLocalMigrations(t *testing.T) {
	t.Run("loads migration versions", func(t *testing.T) {
		// Setup in-memory fs
		files := []string{
			"20220727064246_test.sql",
			"20220727064248_test.sql",
		}
		fsys := fs.MapFS{}
		for _, name := range files {
			fsys[name] = &fs.MapFile{}
		}
		// Run test
		versions, err := ListLocalMigrations(".", fsys)
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, files, versions)
	})

	t.Run("ignores outdated and invalid files", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{
			"20211208000000_init.sql":   &fs.MapFile{},
			"20211208000001_invalid.ts": &fs.MapFile{},
		}
		// Run test
		versions, err := ListLocalMigrations(".", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, versions)
	})

	t.Run("throws error on open failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{"migrations": &fs.MapFile{}}
		// Run test
		_, err := ListLocalMigrations("migrations", fsys)
		// Check error
		assert.ErrorContains(t, err, "failed to read directory:")
	})
}
