package inspect

import (
	"context"
	"embed"
	"fmt"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/pgtest"
)

func TestInspectUtils(t *testing.T) {
	t.Run("loads query from dir", func(t *testing.T) {
		query := ReadQuery("cache")
		assert.Equal(t, query, "SELECT\n  'index hit rate' AS name,\n  (sum(idx_blks_hit)) / nullif(sum(idx_blks_hit + idx_blks_read),0) AS ratio\nFROM pg_statio_user_indexes\nUNION ALL\nSELECT\n  'table hit rate' AS name,\n  sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read),0) AS ratio\nFROM pg_statio_user_tables")
	})

	t.Run("loads non existent query from dir", func(t *testing.T) {
		query := ReadQuery("mysql-binlog")
		assert.Equal(t, query, "")
	})
}

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

var (
	//go:embed queries/cache.sql
	testQuery embed.FS
	//go:embed queries/cache.sql
	sqlString string
)

func TestReportCommand(t *testing.T) {
	t.Run("runs all queries", func(t *testing.T) {
		queries = testQuery
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(fmt.Sprintf(`COPY (%s) TO STDOUT WITH CSV HEADER`, sqlString)).
			Reply("COPY 2")
		// Run test
		err := Report(context.Background(), ".", dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		matches, err := afero.Glob(fsys, "cache_*.csv")
		assert.NoError(t, err)
		assert.Len(t, matches, 1)
	})
}
