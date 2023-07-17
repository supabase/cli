package index_usage

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

const QUERY = `
SELECT relname,
  CASE
    WHEN idx_scan IS NULL THEN 'Insufficient data'
    WHEN idx_scan = 0 THEN 'Insufficient data'
    ELSE (100 * idx_scan / (seq_scan + idx_scan))::text
  END percent_of_times_index_used,
  n_live_tup rows_in_table
FROM
  pg_stat_user_tables
ORDER BY
  CASE
    WHEN idx_scan is null then 1
    WHEN idx_scan = 0 then 1
    ELSE 0
  END,
  n_live_tup DESC;
`

type Result struct {
	Relname                     string
	Percent_of_times_index_used string
	Rows_in_table               string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, QUERY)
	if err != nil {
		return err
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}
	// TODO: implement a markdown table marshaller
	table := "|Table name|Percentage of times index used|Rows in table|\n|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%v`|`%v`|\n", r.Relname, r.Percent_of_times_index_used, r.Rows_in_table)
	}
	return list.RenderTable(table)
}
