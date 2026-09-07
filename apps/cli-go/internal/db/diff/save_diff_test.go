package diff

import (
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestSaveDiff(t *testing.T) {
	t.Run("reports no changes on empty diff", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveDiff(DatabaseDiff{SQL: ""}, "my_diff", fsys))
		entries, err := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.Error(t, err)
		assert.Empty(t, entries)
	})

	t.Run("writes a single migration file", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveDiff(DatabaseDiff{SQL: "create table a ();"}, "my_diff", fsys))
		entries, err := afero.ReadDir(fsys, utils.MigrationsDir)
		require.NoError(t, err)
		require.Len(t, entries, 1)
		assert.Regexp(t, `^\d{14}_my_diff\.sql$`, entries[0].Name())
		contents, err := afero.ReadFile(fsys, utils.MigrationsDir+"/"+entries[0].Name())
		require.NoError(t, err)
		assert.Equal(t, "create table a ();", string(contents))
	})

	t.Run("prints diff to stdout when no file is given", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveDiff(DatabaseDiff{SQL: "create table a ();"}, "", fsys))
		entries, _ := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.Empty(t, entries)
	})

	t.Run("creates nested parent directories for a nested name", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveDiff(DatabaseDiff{SQL: "create table a ();"}, "snapshots/remote", fsys))
		matches, err := afero.Glob(fsys, utils.MigrationsDir+"/*_snapshots/remote.sql")
		require.NoError(t, err)
		require.Len(t, matches, 1)
		contents, err := afero.ReadFile(fsys, matches[0])
		require.NoError(t, err)
		assert.Equal(t, "create table a ();", string(contents))
	})
}
