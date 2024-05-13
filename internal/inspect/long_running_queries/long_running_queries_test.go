package long_running_queries

import (
	"context"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/inspect"
	"github.com/supabase/cli/internal/testing/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestLongQueriesCommand(t *testing.T) {

	// Execute
	t.Run("inspects long running queries", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		conn.Query(inspect.ReadQuery("long_running_queries")).
			Reply("SELECT 1", Result{
				Pid:      1,
				Duration: "300ms",
				Query:    "select 1",
			})
		// Run test
		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

}
