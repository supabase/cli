package locks

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

const LOCKS_QUERY = `
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

type LocksResult struct {
	Pid  string
	Relname string
	Transactionid string
	Granted string
	Query string
	Age string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, LOCKS_QUERY)
	if err != nil {
		return err
	}
	result, err := pgxv5.CollectRows[LocksResult](rows)
	if err != nil {
		return err
	}

	table := "|pid|relname|transaction id|granted|query|age|\n|-|-|-|-|-|-|\n"
	for _, r := range result {
		re := regexp.MustCompile(`\r?\n|\t`)
		query := re.ReplaceAllString(r.Query, " ")
		table += fmt.Sprintf("|`%v`|`%v`|`%v`|`%v`|%s|`%v`|\n", r.Pid, r.Relname, r.Transactionid, r.Granted, query, r.Age)
	}
	return list.RenderTable(table)
}
