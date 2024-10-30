package inspect

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/inspect/bloat"
	"github.com/supabase/cli/internal/inspect/blocking"
	"github.com/supabase/cli/internal/inspect/cache"
	"github.com/supabase/cli/internal/inspect/calls"
	"github.com/supabase/cli/internal/inspect/index_sizes"
	"github.com/supabase/cli/internal/inspect/index_usage"
	"github.com/supabase/cli/internal/inspect/locks"
	"github.com/supabase/cli/internal/inspect/long_running_queries"
	"github.com/supabase/cli/internal/inspect/outliers"
	"github.com/supabase/cli/internal/inspect/replication_slots"
	"github.com/supabase/cli/internal/inspect/role_configs"
	"github.com/supabase/cli/internal/inspect/role_connections"
	"github.com/supabase/cli/internal/inspect/seq_scans"
	"github.com/supabase/cli/internal/inspect/table_index_sizes"
	"github.com/supabase/cli/internal/inspect/table_record_counts"
	"github.com/supabase/cli/internal/inspect/table_sizes"
	"github.com/supabase/cli/internal/inspect/total_index_size"
	"github.com/supabase/cli/internal/inspect/total_table_sizes"
	"github.com/supabase/cli/internal/inspect/unused_indexes"
	"github.com/supabase/cli/internal/inspect/vacuum_stats"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestReportCommand(t *testing.T) {
	t.Run("runs all queries", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(wrapQuery(bloat.BloatQuery)).
			Reply("COPY 0").
			Query(wrapQuery(blocking.BlockingQuery)).
			Reply("COPY 0").
			Query(wrapQuery(cache.CacheQuery)).
			Reply("COPY 0").
			Query(wrapQuery(calls.CallsQuery)).
			Reply("COPY 0").
			Query(wrapQuery(index_sizes.IndexSizesQuery)).
			Reply("COPY 0").
			Query(wrapQuery(index_usage.IndexUsageQuery)).
			Reply("COPY 0").
			Query(wrapQuery(locks.LocksQuery)).
			Reply("COPY 0").
			Query(wrapQuery(long_running_queries.LongRunningQueriesQuery)).
			Reply("COPY 0").
			Query(wrapQuery(outliers.OutliersQuery)).
			Reply("COPY 0").
			Query(wrapQuery(replication_slots.ReplicationSlotsQuery)).
			Reply("COPY 0").
			Query(wrapQuery(role_configs.RoleConfigsQuery)).
			Reply("COPY 0").
			Query(wrapQuery(role_connections.RoleConnectionsQuery)).
			Reply("COPY 0").
			Query(wrapQuery(seq_scans.SeqScansQuery)).
			Reply("COPY 0").
			Query(wrapQuery(table_index_sizes.TableIndexSizesQuery)).
			Reply("COPY 0").
			Query(wrapQuery(table_record_counts.TableRecordCountsQuery)).
			Reply("COPY 0").
			Query(wrapQuery(table_sizes.TableSizesQuery)).
			Reply("COPY 0").
			Query(wrapQuery(total_index_size.TotalIndexSizeQuery)).
			Reply("COPY 0").
			Query(wrapQuery(total_table_sizes.TotalTableSizesQuery)).
			Reply("COPY 0").
			Query(wrapQuery(unused_indexes.UnusedIndexesQuery)).
			Reply("COPY 0").
			Query(wrapQuery(vacuum_stats.VacuumStatsQuery)).
			Reply("COPY 0")
		// Run test
		err := Report(context.Background(), ".", dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		matches, err := afero.Glob(fsys, "*.csv")
		assert.NoError(t, err)
		assert.Len(t, matches, 20)
	})
}

func TestWrapQuery(t *testing.T) {
	t.Run("wraps query in csv", func(t *testing.T) {
		assert.Equal(t,
			"COPY (SELECT 1) TO STDOUT WITH CSV HEADER",
			wrapQuery("SELECT 1"),
		)
	})

	t.Run("replaces placeholder value", func(t *testing.T) {
		assert.Equal(t,
			fmt.Sprintf("COPY (SELECT 'a' LIKE ANY(%s)) TO STDOUT WITH CSV HEADER", ignoreSchemas),
			wrapQuery("SELECT 'a' LIKE ANY($1)"),
		)
	})
}
