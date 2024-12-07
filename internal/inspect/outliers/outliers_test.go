package outliers

import (
	"context"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestOutliersCommand(t *testing.T) {
	t.Run("inspects outliers", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(OutliersQuery).
			Reply("SELECT 1", Result{
				Total_exec_time: "0.9",
				Prop_exec_time:  "0.9",
				Ncalls:          "0.9",
				Sync_io_time:    "0.9",
				Query:           "SELECT 1",
			})
		// Run test
		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})
}
