package diff

import (
	"os"
	"testing"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/migration/new"
)

// failOnNthOpenFs fails the Nth create-for-write OpenFile so a mid-loop write
// failure can be exercised deterministically. Stat/mkdir/read calls pass through.
type failOnNthOpenFs struct {
	afero.Fs
	failOn int
	count  int
}

func (f *failOnNthOpenFs) OpenFile(name string, flag int, perm os.FileMode) (afero.File, error) {
	if flag&os.O_CREATE != 0 {
		f.count++
		if f.count == f.failOn {
			return nil, errors.New("simulated open failure")
		}
	}
	return f.Fs.OpenFile(name, flag, perm)
}

func TestWritePgDeltaMigrations(t *testing.T) {
	base := time.Date(2026, 7, 17, 15, 18, 48, 0, time.UTC)

	t.Run("writes a single unit with the unchanged name", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		files := []PgDeltaPlanFile{
			{Order: 1, Name: "schema_changes", TransactionMode: "transactional", SQL: "-- unit 1\n\ncreate table a ();"},
		}
		written, err := WritePgDeltaMigrations(files, base, "remote_schema", fsys)
		require.NoError(t, err)
		require.Len(t, written, 1)
		assert.Equal(t, "20260717151848", written[0].Version)
		expectedPath := new.GetMigrationPath("20260717151848", "remote_schema")
		assert.Equal(t, expectedPath, written[0].Path)
		contents, err := afero.ReadFile(fsys, expectedPath)
		require.NoError(t, err)
		assert.Equal(t, "-- unit 1\n\ncreate table a ();\n", string(contents))
	})

	t.Run("writes one ordered file per unit with strictly increasing versions", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		files := []PgDeltaPlanFile{
			{Order: 1, Name: "schema_changes", TransactionMode: "transactional", SQL: "-- unit 1\n\nalter type mood add value 'ok';"},
			{Order: 2, Name: "after_enum_values", TransactionMode: "transactional", SQL: "-- unit 2\n\ninsert into t values ('ok');"},
			{Order: 3, Name: "non_transactional", TransactionMode: "none", SQL: "-- unit 3\n\ncreate index concurrently i on t (c);"},
		}
		written, err := WritePgDeltaMigrations(files, base, "remote_schema", fsys)
		require.NoError(t, err)
		require.Len(t, written, 3)

		wantVersions := []string{"20260717151848", "20260717151849", "20260717151850"}
		wantNames := []string{"remote_schema_schema_changes", "remote_schema_after_enum_values", "remote_schema_non_transactional"}
		for i, w := range written {
			assert.Equal(t, wantVersions[i], w.Version)
			assert.Equal(t, new.GetMigrationPath(wantVersions[i], wantNames[i]), w.Path)
			contents, err := afero.ReadFile(fsys, w.Path)
			require.NoError(t, err)
			assert.Equal(t, files[i].SQL+"\n", string(contents))
		}
		// Versions are strictly increasing so history + execution order stay stable.
		assert.True(t, written[0].Version < written[1].Version)
		assert.True(t, written[1].Version < written[2].Version)
	})

	t.Run("creates nested parent directories for a nested migration name", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		files := []PgDeltaPlanFile{
			{Order: 1, Name: "schema_changes", TransactionMode: "transactional", SQL: "create table a ();"},
			{Order: 2, Name: "after_enum_values", TransactionMode: "transactional", SQL: "insert into t values ('ok');"},
		}
		written, err := WritePgDeltaMigrations(files, base, "snapshots/remote", fsys)
		require.NoError(t, err)
		require.Len(t, written, 2)
		for i, w := range written {
			contents, err := afero.ReadFile(fsys, w.Path)
			require.NoError(t, err)
			assert.Equal(t, files[i].SQL+"\n", string(contents))
		}
	})

	t.Run("bumps the base version when a target file already exists", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		files := []PgDeltaPlanFile{
			{Order: 1, Name: "schema_changes", TransactionMode: "transactional", SQL: "create table a ();"},
			{Order: 2, Name: "after_enum_values", TransactionMode: "transactional", SQL: "insert into t values ('ok');"},
		}
		// Pre-existing migration at the first version the base would otherwise use.
		existing := new.GetMigrationPath("20260717151848", "remote_schema_schema_changes")
		require.NoError(t, afero.WriteFile(fsys, existing, []byte("-- pre-existing\n"), 0644))

		written, err := WritePgDeltaMigrations(files, base, "remote_schema", fsys)
		require.NoError(t, err)
		require.Len(t, written, 2)
		// The whole set advances one second so it skips the colliding version and
		// stays strictly ascending against the pre-existing file.
		assert.Equal(t, "20260717151849", written[0].Version)
		assert.Equal(t, "20260717151850", written[1].Version)
		assert.True(t, written[0].Version < written[1].Version)
		// The pre-existing file is untouched (never overwritten).
		contents, err := afero.ReadFile(fsys, existing)
		require.NoError(t, err)
		assert.Equal(t, "-- pre-existing\n", string(contents))
	})

	t.Run("removes already-written files when a later write fails", func(t *testing.T) {
		fsys := &failOnNthOpenFs{Fs: afero.NewMemMapFs(), failOn: 2}
		files := []PgDeltaPlanFile{
			{Order: 1, Name: "schema_changes", TransactionMode: "transactional", SQL: "create table a ();"},
			{Order: 2, Name: "after_enum_values", TransactionMode: "transactional", SQL: "insert into t values ('ok');"},
		}
		written, err := WritePgDeltaMigrations(files, base, "remote_schema", fsys)
		require.Error(t, err)
		assert.Nil(t, written)
		// The first unit's file was written then removed on the failure, so nothing
		// from this invocation is left behind.
		first := new.GetMigrationPath("20260717151848", "remote_schema_schema_changes")
		exists, statErr := afero.Exists(fsys, first)
		require.NoError(t, statErr)
		assert.False(t, exists)
	})
}
