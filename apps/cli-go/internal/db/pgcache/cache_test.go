package pgcache

import (
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestResolveMigrationCatalogPathUsesLatestTimestamp(t *testing.T) {
	fsys := afero.NewMemMapFs()
	temp := filepath.Join(utils.TempDir, "pgdelta")
	require.NoError(t, fsys.MkdirAll(temp, 0755))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-migrations-abc-1000.json"), []byte("{}"), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-migrations-abc-2000.json"), []byte("{}"), 0644))

	path, ok, err := ResolveMigrationCatalogPath(fsys, "abc", "local")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, filepath.Join(temp, "catalog-local-migrations-abc-2000.json"), path)
}

func TestCleanupOldMigrationCatalogsKeepsLatestTwo(t *testing.T) {
	fsys := afero.NewMemMapFs()
	temp := filepath.Join(utils.TempDir, "pgdelta")
	require.NoError(t, fsys.MkdirAll(temp, 0755))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-migrations-a-1000.json"), []byte("{}"), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-migrations-b-2000.json"), []byte("{}"), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-migrations-c-3000.json"), []byte("{}"), 0644))

	require.NoError(t, CleanupOldMigrationCatalogs(fsys, "local"))

	ok, err := afero.Exists(fsys, filepath.Join(temp, "catalog-local-migrations-a-1000.json"))
	require.NoError(t, err)
	assert.False(t, ok)

	ok, err = afero.Exists(fsys, filepath.Join(temp, "catalog-local-migrations-b-2000.json"))
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = afero.Exists(fsys, filepath.Join(temp, "catalog-local-migrations-c-3000.json"))
	require.NoError(t, err)
	assert.True(t, ok)
}
