package calls

import (
	"context"
	"fmt"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/pgxv5"
)

const CALLS_QUERY = `
SELECT
	query,
	interval '1 millisecond' * total_exec_time AS total_exec_time,
	to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
	to_char(calls, 'FM999G999G990') AS ncalls,
	interval '1 millisecond' * (blk_read_time + blk_write_time) AS sync_io_time
FROM pg_stat_statements	
ORDER BY calls DESC
LIMIT 10
`

type CallsResult struct {
	Total_exec_time  string
	Prop_exec_time string
	Ncalls string
	Sync_io_time string
	Query string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, CALLS_QUERY)
	if err != nil {
		return err
	}
	result, err := pgxv5.CollectRows[CallsResult](rows)
	if err != nil {
		return err
	}
	// TODO: implement a markdown table marshaller
	table := "|Query|Execution Time|Proportion of exec time|Number Calls|Sync IO time|\n|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|`%s`|`%s`|\n", r.Query, r.Total_exec_time, r.Prop_exec_time, r.Ncalls, r.Sync_io_time)
	}
	return list.RenderTable(table)
}
