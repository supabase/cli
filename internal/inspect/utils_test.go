package inspect

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestInspectUtils(t *testing.T) {

	// Execute
	t.Run("loads query from dir", func(t *testing.T) {
		query := ReadQuery("cache")
		assert.Equal(t, query, "SELECT\n  'index hit rate' AS name,\n  (sum(idx_blks_hit)) / nullif(sum(idx_blks_hit + idx_blks_read),0) AS ratio\nFROM pg_statio_user_indexes\nUNION ALL\nSELECT\n  'table hit rate' AS name,\n  sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read),0) AS ratio\nFROM pg_statio_user_tables")
	})

	t.Run("loads non existent query from dir", func(t *testing.T) {
		query := ReadQuery("mysql-binlog")
		assert.Equal(t, query, "")
	})
}
