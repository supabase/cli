package table_index_sizes

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

func TestTableIndexSizesCommand(t *testing.T) {
	t.Run("inspects table index sizes", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(TableIndexSizesQuery, reset.LikeEscapeSchema(utils.InternalSchemas)).
			Reply("SELECT 1", Result{
				Table:      "public.test_table",
				Index_size: "3GB",
			})
		// Run test
		err := Run(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})
}
