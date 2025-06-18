package db_stats

import (
	"context"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestDBStatsCommand(t *testing.T) {
	t.Run("inspects size of all indexes", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(DBStatsQuery, reset.LikeEscapeSchema(utils.InternalSchemas), dbConfig.Database).
			Reply("SELECT 1", Result{
				Database_size:          "8GB",
				Total_index_size:       "8GB",
				Total_table_size:       "8GB",
				Total_toast_size:       "8GB",
				Time_since_stats_reset: "8GB",
				Index_hit_rate:         "0.89",
				Table_hit_rate:         "0.98",
				WAL_size:               "8GB",
			})
		// Run test
		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})
}
