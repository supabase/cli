package inspect

import (
	"context"
	"fmt"
	"io/fs"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestReportCommand(t *testing.T) {
	t.Run("runs all queries", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Iterate over all embedded SQL files
		sqlPaths, err := fs.Glob(queries, "*/*.sql")
		require.NoError(t, err)
		for _, fp := range sqlPaths {
			data, err := queries.ReadFile(fp)
			require.NoError(t, err)
			sql := wrapQuery(string(data), ignoreSchemas, fmt.Sprintf("'%s'", dbConfig.Database))
			conn.Query(sql).Reply("COPY 0")
		}
		// Run test
		err = Report(context.Background(), ".", dbConfig, fsys, conn.Intercept)
		assert.NoError(t, err)
		matches, err := afero.Glob(fsys, "*/*.csv")
		assert.NoError(t, err)
		assert.Len(t, matches, len(sqlPaths))
	})
}

func TestWrapQuery(t *testing.T) {
	t.Run("wraps query in csv", func(t *testing.T) {
		assert.Equal(t,
			"COPY (SELECT 1) TO STDOUT WITH CSV HEADER",
			wrapQuery("SELECT 1"),
		)
	})

	t.Run("replaces placeholder value", func(t *testing.T) {
		assert.Equal(t,
			fmt.Sprintf("COPY (SELECT 'a' LIKE ANY(%s)) TO STDOUT WITH CSV HEADER", ignoreSchemas),
			wrapQuery("SELECT 'a' LIKE ANY($1)", ignoreSchemas),
		)
	})
}
