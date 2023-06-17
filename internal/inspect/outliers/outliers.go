package outliers

import (
	"context"
	"fmt"
	"regexp"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/pgxv5"
)

const OUTLIERS_QUERY = `
SELECT
	interval '1 millisecond' * total_exec_time AS total_exec_time,
	to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
	to_char(calls, 'FM999G999G999G990') AS ncalls,
	interval '1 millisecond' * (blk_read_time + blk_write_time) AS sync_io_time,
	query
FROM pg_stat_statements WHERE userid = (SELECT usesysid FROM pg_user WHERE usename = current_user LIMIT 1)
ORDER BY total_exec_time DESC
LIMIT 10
`

type OutliersResult struct {
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
	rows, err := conn.Query(ctx, OUTLIERS_QUERY)
	if err != nil {
		return err
	}
	result, err := pgxv5.CollectRows[OutliersResult](rows)
	if err != nil {
		return err
	}
	// TODO: implement a markdown table marshaller
	table := "|Query|Execution Time|Proportion of exec time|Number Calls|Sync IO time|\n|-|-|-|-|-|\n"
	for _, r := range result {
		re := regexp.MustCompile(`\s+|\r+|\n+|\t+|\v`)
		query := re.ReplaceAllString(r.Query, " ")

		re = regexp.MustCompile(`\|`)
		query = re.ReplaceAllString(query, `\|`)
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|`%s`|`%s`|\n", query, r.Total_exec_time, r.Prop_exec_time, r.Ncalls, r.Sync_io_time)
	}
	return list.RenderTable(table)
}
