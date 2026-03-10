package declarative

import (
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/utils"
)

func TestWriteDeclarativeSchemas(t *testing.T) {
	// This verifies the main happy path for declarative export materialization:
	// files are written to expected locations and config is updated accordingly.
	fsys := afero.NewMemMapFs()
	require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("[db]\n"), 0644))

	output := diff.DeclarativeOutput{
		Files: []diff.DeclarativeFile{
			{Path: "cluster/roles.sql", SQL: "create role app;"},
			{Path: "schemas/public/tables/users.sql", SQL: "create table users(id bigint);"},
		},
	}

	err := WriteDeclarativeSchemas(output, fsys)
	require.NoError(t, err)

	roles, err := afero.ReadFile(fsys, filepath.Join(utils.DeclarativeDir, "cluster", "roles.sql"))
	require.NoError(t, err)
	assert.Equal(t, "create role app;", string(roles))

	users, err := afero.ReadFile(fsys, filepath.Join(utils.DeclarativeDir, "schemas", "public", "tables", "users.sql"))
	require.NoError(t, err)
	assert.Equal(t, "create table users(id bigint);", string(users))

	cfg, err := afero.ReadFile(fsys, utils.ConfigPath)
	require.NoError(t, err)
	assert.Contains(t, string(cfg), `declarative/`)
}

func TestWriteDeclarativeSchemasRejectsUnsafePath(t *testing.T) {
	// Export paths must stay within supabase/declarative to prevent traversal.
	fsys := afero.NewMemMapFs()
	err := WriteDeclarativeSchemas(diff.DeclarativeOutput{
		Files: []diff.DeclarativeFile{
			{Path: "../oops.sql", SQL: "select 1;"},
		},
	}, fsys)
	assert.ErrorContains(t, err, "unsafe declarative export path")
}

func TestHashMigrationsChangesWithContent(t *testing.T) {
	// Cache keys must change whenever migration SQL changes.
	fsys := afero.NewMemMapFs()
	p1 := filepath.Join(utils.MigrationsDir, "20240101000000_first.sql")
	p2 := filepath.Join(utils.MigrationsDir, "20240101000001_second.sql")
	require.NoError(t, afero.WriteFile(fsys, p1, []byte("create table a();"), 0644))
	require.NoError(t, afero.WriteFile(fsys, p2, []byte("create table b();"), 0644))

	h1, err := hashMigrations(fsys)
	require.NoError(t, err)
	require.NotEmpty(t, h1)

	require.NoError(t, afero.WriteFile(fsys, p2, []byte("create table b(id bigint);"), 0644))
	h2, err := hashMigrations(fsys)
	require.NoError(t, err)

	assert.NotEqual(t, h1, h2)
}

func TestGetMigrationsCatalogRefUsesCache(t *testing.T) {
	// When a matching hash snapshot exists, catalog generation should be skipped.
	fsys := afero.NewMemMapFs()
	p := filepath.Join(utils.MigrationsDir, "20240101000000_first.sql")
	require.NoError(t, afero.WriteFile(fsys, p, []byte("create table a();"), 0644))
	hash, err := hashMigrations(fsys)
	require.NoError(t, err)

	cachePath := filepath.Join(utils.TempDir, "pgdelta", "catalog-migrations-"+hash+".json")
	require.NoError(t, afero.WriteFile(fsys, cachePath, []byte(`{"version":1}`), 0644))

	ref, err := getMigrationsCatalogRef(t.Context(), false, fsys)
	require.NoError(t, err)
	assert.Equal(t, cachePath, ref)
}
