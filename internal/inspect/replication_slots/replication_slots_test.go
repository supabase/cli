package replication_slots

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

func TestReplicationCommand(t *testing.T) {

	// Execute
	t.Run("inspects replication slots", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		conn.Query(inspect.ReadQuery("replication_slots")).
			Reply("SELECT 1", Result{
				Slot_name:                  "test",
				Active:                     true,
				State:                      "active",
				Replication_client_address: "127.0.0.1",
				Replication_lag_gb:         "0.9",
			})
		// Run test
		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

}
