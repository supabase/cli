package traffic_profile

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

func TestTrafficProfile(t *testing.T) {
	t.Run("inspects traffic profile", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(TrafficProfileQuery).
			Reply("SELECT 6", Result{
				Schemaname:     "public",
				Table_name:     "users",
				Blocks_read:    1000,
				Write_tuples:   500,
				Blocks_write:   250.5,
				Activity_ratio: "1:4.0 (Read-Heavy)",
			})
		// Run test
		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})
}
