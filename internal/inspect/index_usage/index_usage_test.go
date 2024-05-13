package index_usage

import (
	"context"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/inspect"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestIndexUsage(t *testing.T) {

	// Execute
	t.Run("inspects index usage", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		conn.Query(inspect.ReadQuery("index_usage"), reset.LikeEscapeSchema(utils.InternalSchemas)).
			Reply("SELECT 1", Result{
				Name:                        "test_table_idx",
				Percent_of_times_index_used: "0.9",
				Rows_in_table:               300,
			})
		// Run test
		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

}
