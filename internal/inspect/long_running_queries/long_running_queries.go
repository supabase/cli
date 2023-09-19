package long_running_queries

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
SELECT
  pid,
  now() - pg_stat_activity.query_start AS duration,
  query AS query
FROM
  pg_stat_activity
WHERE
  pg_stat_activity.query <> ''::text
  AND state <> 'idle'
  AND now() - pg_stat_activity.query_start > interval '5 minutes'
ORDER BY
  now() - pg_stat_activity.query_start DESC;`

type Result struct {
	Pid      string
	Duration string
	Query    string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
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

	table := "|pid|Duration|Query|\n|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|\n", r.Pid, r.Duration, r.Query)
	}
	return list.RenderTable(table)
}
