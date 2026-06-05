package diff

import (
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

const partitionFilterSnippet = `"table/is_partition": true`

func TestPgDeltaTemplatesExcludePartitionChildren(t *testing.T) {
	t.Run("pgdelta.ts applies default partition filter", func(t *testing.T) {
		assert.Contains(t, pgDeltaScript, partitionFilterSnippet)
		assert.Contains(t, pgDeltaScript, "partitionFilter")
	})

	t.Run("pgdelta_declarative_export.ts applies default partition filter", func(t *testing.T) {
		assert.Contains(t, pgDeltaDeclarativeExportScript, partitionFilterSnippet)
		assert.Contains(t, pgDeltaDeclarativeExportScript, "partitionFilter")
	})

	t.Run("partition filter is always composed into supabase.filter", func(t *testing.T) {
		for _, script := range []string{pgDeltaScript, pgDeltaDeclarativeExportScript} {
			assert.True(t, strings.Contains(script, "filterParts = [supabase.filter!, partitionFilter]"))
		}
	})
}

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
