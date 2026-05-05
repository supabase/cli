package declarative

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestSaveDebugBundleCreatesAllFiles(t *testing.T) {
	fsys := afero.NewMemMapFs()

	// Write source and target catalog files
	sourceRef := filepath.Join(utils.TempDir, "pgdelta", "source.json")
	targetRef := filepath.Join(utils.TempDir, "pgdelta", "target.json")
	require.NoError(t, fsys.MkdirAll(filepath.Join(utils.TempDir, "pgdelta"), 0755))
	require.NoError(t, afero.WriteFile(fsys, sourceRef, []byte(`{"source":true}`), 0644))
	require.NoError(t, afero.WriteFile(fsys, targetRef, []byte(`{"target":true}`), 0644))

	// Write migration files so they can be copied
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.MigrationsDir, "20240101000000_init.sql"), []byte("create table a();"), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.MigrationsDir, "20240102000000_users.sql"), []byte("create table b();"), 0644))

	bundle := DebugBundle{
		ID:           "20240414-044403",
		SourceRef:    sourceRef,
		TargetRef:    targetRef,
		MigrationSQL: "ALTER TABLE users ADD COLUMN email text;",
		Error:        errors.New("diff failed: something went wrong"),
		Migrations:   []string{"20240101000000_init.sql", "20240102000000_users.sql"},
	}

	debugDir, err := SaveDebugBundle(bundle, fsys)
	require.NoError(t, err)
	assert.Contains(t, debugDir, "20240414-044403")

	// Verify all files were created
	source, err := afero.ReadFile(fsys, filepath.Join(debugDir, "source-catalog.json"))
	require.NoError(t, err)
	assert.JSONEq(t, `{"source":true}`, string(source))

	target, err := afero.ReadFile(fsys, filepath.Join(debugDir, "target-catalog.json"))
	require.NoError(t, err)
	assert.JSONEq(t, `{"target":true}`, string(target))

	migrationSQL, err := afero.ReadFile(fsys, filepath.Join(debugDir, "generated-migration.sql"))
	require.NoError(t, err)
	assert.Equal(t, "ALTER TABLE users ADD COLUMN email text;", string(migrationSQL))

	errorTxt, err := afero.ReadFile(fsys, filepath.Join(debugDir, "error.txt"))
	require.NoError(t, err)
	assert.Equal(t, "diff failed: something went wrong", string(errorTxt))

	// Verify migration files were copied with full content
	initSQL, err := afero.ReadFile(fsys, filepath.Join(debugDir, "migrations", "20240101000000_init.sql"))
	require.NoError(t, err)
	assert.Equal(t, "create table a();", string(initSQL))

	usersSQL, err := afero.ReadFile(fsys, filepath.Join(debugDir, "migrations", "20240102000000_users.sql"))
	require.NoError(t, err)
	assert.Equal(t, "create table b();", string(usersSQL))
}

func TestSaveDebugBundlePartialData(t *testing.T) {
	fsys := afero.NewMemMapFs()

	bundle := DebugBundle{
		ID:    "20240414-050000",
		Error: errors.New("connection refused"),
	}

	debugDir, err := SaveDebugBundle(bundle, fsys)
	require.NoError(t, err)

	// Only error.txt should exist
	errorTxt, err := afero.ReadFile(fsys, filepath.Join(debugDir, "error.txt"))
	require.NoError(t, err)
	assert.Equal(t, "connection refused", string(errorTxt))

	// Other files should not exist
	exists, err := afero.Exists(fsys, filepath.Join(debugDir, "source-catalog.json"))
	require.NoError(t, err)
	assert.False(t, exists)

	exists, err = afero.Exists(fsys, filepath.Join(debugDir, "target-catalog.json"))
	require.NoError(t, err)
	assert.False(t, exists)

	exists, err = afero.Exists(fsys, filepath.Join(debugDir, "generated-migration.sql"))
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestSaveDebugBundleGeneratesID(t *testing.T) {
	fsys := afero.NewMemMapFs()

	bundle := DebugBundle{
		Error: errors.New("test error"),
	}

	debugDir, err := SaveDebugBundle(bundle, fsys)
	require.NoError(t, err)
	assert.NotEmpty(t, debugDir)

	// Should contain a timestamp-like ID
	errorTxt, err := afero.ReadFile(fsys, filepath.Join(debugDir, "error.txt"))
	require.NoError(t, err)
	assert.Equal(t, "test error", string(errorTxt))
}

func TestCollectMigrationsList(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.MigrationsDir, "20240101000000_init.sql"), []byte("create table a();"), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.MigrationsDir, "20240102000000_users.sql"), []byte("create table b();"), 0644))

	migrations := CollectMigrationsList(fsys)
	assert.Len(t, migrations, 2)
}

func TestCollectMigrationsListEmpty(t *testing.T) {
	fsys := afero.NewMemMapFs()

	migrations := CollectMigrationsList(fsys)
	assert.Empty(t, migrations)
}
