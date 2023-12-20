package locks

import (
	"context"
	"fmt"
	"regexp"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/pgxv5"
)

const QUERY = `
SELECT
	pg_stat_activity.pid,
	COALESCE(pg_class.relname, 'null') AS relname,
	COALESCE(pg_locks.transactionid, 'null') AS transactionid,
	pg_locks.granted,
	pg_stat_activity.query,
	age(now(),pg_stat_activity.query_start) AS age
FROM pg_stat_activity, pg_locks LEFT OUTER JOIN pg_class ON (pg_locks.relation = pg_class.oid)
WHERE pg_stat_activity.query <> '<insufficient privilege>'
AND pg_locks.pid=pg_stat_activity.pid
AND pg_locks.mode = 'ExclusiveLock'
ORDER BY query_start;
`

type Result struct {
	Pid           string
	Relname       string
	Transactionid string
	Granted       string
	Query         string
	Age           string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, QUERY)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|pid|relname|transaction id|granted|query|age|\n|-|-|-|-|-|-|\n"
	for _, r := range result {
		// remove whitespace from query
		re := regexp.MustCompile(`\s+|\r+|\n+|\t+|\v`)
		query := re.ReplaceAllString(r.Query, " ")

		// escape pipes in query
		re = regexp.MustCompile(`\|`)
		query = re.ReplaceAllString(query, `\|`)
		table += fmt.Sprintf("|`%v`|`%v`|`%v`|`%v`|%s|`%v`|\n", r.Pid, r.Relname, r.Transactionid, r.Granted, query, r.Age)
	}
	return list.RenderTable(table)
}
