package index_stats

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

func TestIndexStatsCommand(t *testing.T) {
	t.Run("inspects index stats", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		conn := pgtest.NewConn()
		defer conn.Close(t)

		// Mock index stats
		conn.Query(IndexStatsQuery, reset.LikeEscapeSchema(utils.InternalSchemas)).
			Reply("SELECT 1", Result{
				Name:         "public.test_idx",
				Size:         "1GB",
				Percent_used: "50%",
				Index_scans:  5,
				Seq_scans:    5,
				Unused:       false,
			})

		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		assert.NoError(t, err)
	})
}
