package vacuum_stats

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

func TestVacuumCommand(t *testing.T) {
	t.Run("inspects vacuum stats", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(VacuumStatsQuery, reset.LikeEscapeSchema(utils.InternalSchemas)).
			Reply("SELECT 1", Result{
				Name:                 "test_schema.test_table",
				Last_vacuum:          "2021-01-01 00:00:00",
				Last_autovacuum:      "2021-01-01 00:00:00",
				Rowcount:             "1000",
				Dead_rowcount:        "100",
				Autovacuum_threshold: "100",
				Expect_autovacuum:    "yes",
			})
		// Run test
		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})
}
