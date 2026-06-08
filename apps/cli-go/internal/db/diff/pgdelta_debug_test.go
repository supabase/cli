package diff

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestIsPgDeltaDebugEnabled(t *testing.T) {
	t.Run("disabled by default", func(t *testing.T) {
		t.Setenv("PGDELTA_DEBUG", "")
		assert.False(t, IsPgDeltaDebugEnabled())
	})

	t.Run("enabled for 1", func(t *testing.T) {
		t.Setenv("PGDELTA_DEBUG", "1")
		assert.True(t, IsPgDeltaDebugEnabled())
	})

	t.Run("enabled for true", func(t *testing.T) {
		t.Setenv("PGDELTA_DEBUG", "true")
		assert.True(t, IsPgDeltaDebugEnabled())
	})

	t.Run("enabled for yes", func(t *testing.T) {
		t.Setenv("PGDELTA_DEBUG", "YES")
		assert.True(t, IsPgDeltaDebugEnabled())
	})
}

func TestSummarizeCatalogJSON(t *testing.T) {
	t.Run("counts schema objects", func(t *testing.T) {
		catalog := `{
			"schemas": [
				{"schema": "public", "tables": [{"schema": "public", "name": "airports"}]},
				{"schema": "auth", "tables": [{"schema": "auth", "name": "users"}]}
			]
		}`
		summary := SummarizeCatalogJSON(catalog)
		assert.Equal(t, 4, summary.TotalObjects)
		assert.Equal(t, 2, summary.BySchema["public"])
		assert.Equal(t, 2, summary.BySchema["auth"])
	})

	t.Run("returns empty summary for invalid json", func(t *testing.T) {
		summary := SummarizeCatalogJSON("{not-json")
		assert.Equal(t, 0, summary.TotalObjects)
		assert.Empty(t, summary.BySchema)
	})
}
