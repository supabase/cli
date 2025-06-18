package unused_indexes

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

func TestUnusedIndexesCommand(t *testing.T) {
	t.Run("inspects unused indexes", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(UnusedIndexesQuery, reset.LikeEscapeSchema(utils.InternalSchemas)).
			Reply("SELECT 1", Result{
				Name:        "public.test_table",
				Index:       "test_table_idx",
				Index_size:  "3GB",
				Index_scans: 2,
			})
		// Run test
		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})
}
