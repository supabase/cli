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
		// Nothing written when there are no schema changes.
		entries, err := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.Error(t, err)
		assert.Empty(t, entries)
	})

	t.Run("writes a single migration file for a single-unit plan", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		files := []PgDeltaPlanFile{
			{Order: 1, Name: "schema_changes", TransactionMode: "transactional", SQL: "create table a ();"},
		}
		result := DatabaseDiff{SQL: joinPgDeltaFiles(files), Files: files}
		require.NoError(t, SaveDiff(result, "my_diff", fsys))
		entries, err := afero.ReadDir(fsys, utils.MigrationsDir)
		require.NoError(t, err)
		require.Len(t, entries, 1)
		// A single-unit plan keeps the plain `<ts>_<name>.sql` name and the exact
		// diff SQL, byte-identical to the pre-multi-file behavior (no trailing newline
		// added, no unit-name suffix).
		assert.Regexp(t, `^\d{14}_my_diff\.sql$`, entries[0].Name())
		contents, err := afero.ReadFile(fsys, utils.MigrationsDir+"/"+entries[0].Name())
		require.NoError(t, err)
		assert.Equal(t, "create table a ();", string(contents))
	})

	t.Run("writes one migration file per unit for a multi-unit plan", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		files := []PgDeltaPlanFile{
			{Order: 1, Name: "schema_changes", TransactionMode: "transactional", SQL: "alter type mood add value 'ok';"},
			{Order: 2, Name: "after_enum_values", TransactionMode: "transactional", SQL: "insert into t values ('ok');"},
		}
		result := DatabaseDiff{SQL: joinPgDeltaFiles(files), Files: files}
		require.NoError(t, SaveDiff(result, "my_diff", fsys))
		entries, err := afero.ReadDir(fsys, utils.MigrationsDir)
		require.NoError(t, err)
		require.Len(t, entries, 2)
		// Multi-unit plans split into one ordered file per unit, each suffixed with the
		// unit name, so `db push`/`reset` applies each unit as its own transaction.
		assert.Regexp(t, `^\d{14}_my_diff_schema_changes\.sql$`, entries[0].Name())
		assert.Regexp(t, `^\d{14}_my_diff_after_enum_values\.sql$`, entries[1].Name())
	})

	t.Run("prints diff to stdout when no file is given", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveDiff(DatabaseDiff{SQL: "create table a ();"}, "", fsys))
		entries, _ := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.Empty(t, entries)
	})

	t.Run("creates nested parent directories for a nested single-unit name", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveDiff(DatabaseDiff{SQL: "create table a ();"}, "snapshots/remote", fsys))
		matches, err := afero.Glob(fsys, utils.MigrationsDir+"/*_snapshots/remote.sql")
		require.NoError(t, err)
		require.Len(t, matches, 1)
		contents, err := afero.ReadFile(fsys, matches[0])
		require.NoError(t, err)
		assert.Equal(t, "create table a ();", string(contents))
	})

	t.Run("creates nested parent directories for a nested multi-unit name", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		files := []PgDeltaPlanFile{
			{Order: 1, Name: "schema_changes", TransactionMode: "transactional", SQL: "alter type mood add value 'ok';"},
			{Order: 2, Name: "after_enum_values", TransactionMode: "transactional", SQL: "insert into t values ('ok');"},
		}
		result := DatabaseDiff{SQL: joinPgDeltaFiles(files), Files: files}
		require.NoError(t, SaveDiff(result, "snapshots/remote", fsys))
		matches, err := afero.Glob(fsys, utils.MigrationsDir+"/*_snapshots/remote_*.sql")
		require.NoError(t, err)
		require.Len(t, matches, 2)
	})
}
