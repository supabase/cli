package diff

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestResolveExplicitDatabaseRef(t *testing.T) {
	fsys := afero.NewMemMapFs()
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Db.Port = 54322
	utils.Config.Db.Password = "postgres"

	t.Run("resolves local database", func(t *testing.T) {
		ref, err := resolveExplicitDatabaseRef(context.Background(), "local", fsys, nil, nil)

		require.NoError(t, err)
		assert.Equal(t, "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10", ref)
	})

	t.Run("passes through database url", func(t *testing.T) {
		ref, err := resolveExplicitDatabaseRef(context.Background(), "postgres://user:pass@db.example.com:5432/postgres", fsys, nil, nil)

		require.NoError(t, err)
		assert.Equal(t, "postgres://user:pass@db.example.com:5432/postgres", ref)
	})

	t.Run("resolves linked database via provider", func(t *testing.T) {
		ref, err := resolveExplicitDatabaseRef(context.Background(), "linked", fsys, func(context.Context, afero.Fs) (pgconn.Config, error) {
			return pgconn.Config{
				Host:     "db.abcdefghijklmnopqrst.supabase.co",
				Port:     5432,
				User:     "postgres",
				Password: "secret",
				Database: "postgres",
			}, nil
		}, nil)

		require.NoError(t, err)
		assert.Equal(t, "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?connect_timeout=10", ref)
	})

	t.Run("rejects unknown target", func(t *testing.T) {
		_, err := resolveExplicitDatabaseRef(context.Background(), "invalid", fsys, nil, nil)

		require.Error(t, err)
		assert.Contains(t, err.Error(), "unknown target")
	})

	t.Run("resolves migrations catalog via provider", func(t *testing.T) {
		expected := filepath.Join(utils.TempDir, "pgdelta", "catalog-local.json")
		ref, err := resolveExplicitDatabaseRef(context.Background(), "migrations", fsys, nil, func(context.Context, afero.Fs, ...func(*pgx.ConnConfig)) (string, error) {
			return expected, nil
		})

		require.NoError(t, err)
		assert.Equal(t, expected, ref)
	})
}

func TestWriteOutput(t *testing.T) {
	fsys := afero.NewMemMapFs()

	err := writeOutput("create table test();\n", filepath.Join("tmp", "diff.sql"), fsys)
	require.NoError(t, err)

	written, err := afero.ReadFile(fsys, filepath.Join("tmp", "diff.sql"))
	require.NoError(t, err)
	assert.Equal(t, "create table test();\n", string(written))
}
