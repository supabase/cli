package diff

import (
	"testing"
	"time"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/migration/new"
)

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
}
