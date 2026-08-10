package diff

import (
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestContainerRef(t *testing.T) {
	t.Run("passes empty string through", func(t *testing.T) {
		assert.Equal(t, "", containerRef(""))
	})

	t.Run("passes postgres URLs through", func(t *testing.T) {
		assert.Equal(t, "postgresql://user@host:5432/db", containerRef("postgresql://user@host:5432/db"))
		assert.Equal(t, "postgres://user@host:5432/db", containerRef("postgres://user@host:5432/db"))
	})

	t.Run("normalises Windows path separators", func(t *testing.T) {
		if runtime.GOOS != "windows" {
			t.Skip("path separator behaviour is Windows-only")
		}
		// On Windows, filepath.Join produces backslashes which the Linux
		// container cannot read; containerRef must convert them.
		ref := `supabase\.temp\pgdelta\catalog-baseline-17.6.1.106.json`
		assert.Equal(t, "/workspace/supabase/.temp/pgdelta/catalog-baseline-17.6.1.106.json", containerRef(ref))
	})

	t.Run("leaves unix paths untouched", func(t *testing.T) {
		ref := "supabase/.temp/pgdelta/catalog-baseline-17.6.1.106.json"
		assert.Equal(t, "/workspace/supabase/.temp/pgdelta/catalog-baseline-17.6.1.106.json", containerRef(ref))
	})
}

func TestParsePgDeltaDiffOutput(t *testing.T) {
	t.Run("parses a multi-file envelope", func(t *testing.T) {
		stdout := `{"version":1,"files":[` +
			`{"order":1,"name":"schema_changes","transactionMode":"transactional","sql":"-- unit 1\n\nCREATE TABLE a ();"},` +
			`{"order":2,"name":"after_enum_values","transactionMode":"transactional","sql":"-- unit 2\n\nINSERT INTO a VALUES (1);"}` +
			`]}`
		result, err := parsePgDeltaDiffOutput(stdout, "debug stderr")
		assert.NoError(t, err)
		assert.Equal(t, "debug stderr", result.Stderr)
		assert.Len(t, result.Files, 2)
		assert.Equal(t, PgDeltaPlanFile{Order: 1, Name: "schema_changes", TransactionMode: "transactional", SQL: "-- unit 1\n\nCREATE TABLE a ();"}, result.Files[0])
		assert.Equal(t, "after_enum_values", result.Files[1].Name)
		// The flattened join keeps unit boundaries visible via header comments.
		assert.Equal(t, "-- unit 1\n\nCREATE TABLE a ();\n\n-- unit 2\n\nINSERT INTO a VALUES (1);", joinPgDeltaFiles(result.Files))
	})

	t.Run("treats an empty envelope as no changes", func(t *testing.T) {
		result, err := parsePgDeltaDiffOutput(`{"version":1,"files":[]}`, "")
		assert.NoError(t, err)
		assert.Empty(t, result.Files)
		assert.Equal(t, "", joinPgDeltaFiles(result.Files))
	})

	t.Run("treats empty stdout as no changes", func(t *testing.T) {
		result, err := parsePgDeltaDiffOutput("   \n", "")
		assert.NoError(t, err)
		assert.Empty(t, result.Files)
	})

	t.Run("fails on malformed json and embeds stderr", func(t *testing.T) {
		_, err := parsePgDeltaDiffOutput("not json", "boom on the edge runtime")
		assert.Error(t, err)
		assert.ErrorContains(t, err, "failed to parse pg-delta diff output")
		assert.ErrorContains(t, err, "boom on the edge runtime")
	})
}
