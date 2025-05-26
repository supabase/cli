package table_stats

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

func TestTableStatsCommand(t *testing.T) {
	t.Run("inspects table stats", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		conn := pgtest.NewConn()
		defer conn.Close(t)

		// Mock table sizes and index sizes
		conn.Query(TableStatsQuery, reset.LikeEscapeSchema(utils.InternalSchemas)).
			Reply("SELECT 1", Result{
				Name:                "public.test_table",
				Table_size:          "3GB",
				Index_size:          "1GB",
				Total_size:          "4GB",
				Estimated_row_count: 100,
				Seq_scans:           1,
			})

		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		assert.NoError(t, err)
	})
}
