package apply

import (
	"bufio"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

func TestMigrateDatabase(t *testing.T) {
	t.Run("ignores empty local directory", func(t *testing.T) {
		assert.NoError(t, MigrateDatabase(context.Background(), nil, afero.NewMemMapFs()))
	})

	t.Run("ignores outdated migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		name := "20211208000000_init.sql"
		path := filepath.Join(utils.MigrationsDir, name)
		query := "create table test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Run test
		err := MigrateDatabase(context.Background(), nil, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := MigrateDatabase(context.Background(), nil, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on open failure", func(t *testing.T) {
		path := filepath.Join(utils.MigrationsDir, "20220727064247_create_table.sql")
		// Setup in-memory fs
		fsys := &OpenErrorFs{DenyPath: path}
		query := "create table test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Run test
		err := MigrateDatabase(context.Background(), nil, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})
}

type OpenErrorFs struct {
	afero.MemMapFs
	DenyPath string
}

func (m *OpenErrorFs) Open(name string) (afero.File, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.Open(name)
}

func TestMigrationFile(t *testing.T) {
	t.Run("new from file sets max token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		name := "20220727064247_create_table.sql"
		path := filepath.Join(utils.MigrationsDir, name)
		query := "BEGIN; " + strings.Repeat("a", parser.MaxScannerCapacity)
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Run test
		migration, err := NewMigrationFromFile(path, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Len(t, migration.Lines, 2)
		assert.Equal(t, "20220727064247", migration.version)
	})

	t.Run("new from reader errors on max token", func(t *testing.T) {
		viper.Reset()
		sql := "\tBEGIN; " + strings.Repeat("a", parser.MaxScannerCapacity)
		// Run test
		migration, err := NewMigrationFromReader(strings.NewReader(sql))
		// Check error
		assert.ErrorIs(t, err, bufio.ErrTooLong)
		assert.ErrorContains(t, err, "After statement 1: \tBEGIN;")
		assert.Nil(t, migration)
	})
}
