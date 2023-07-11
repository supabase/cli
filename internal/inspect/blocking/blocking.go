package blocking

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

// Ref: https://github.com/heroku/heroku-pg-extras/blob/main/commands/blocking.js#L7
const BLOCKING_QUERY = `
SELECT
	bl.pid AS blocked_pid,
	ka.query AS blocking_statement,
	now() - ka.query_start AS blocking_duration,
	kl.pid AS blocking_pid,
	a.query AS blocked_statement,
	now() - a.query_start AS blocked_duration
FROM pg_catalog.pg_locks bl
JOIN pg_catalog.pg_stat_activity a
	ON bl.pid = a.pid
JOIN pg_catalog.pg_locks kl
JOIN pg_catalog.pg_stat_activity ka
	ON kl.pid = ka.pid
	ON bl.transactionid = kl.transactionid AND bl.pid != kl.pid
WHERE NOT bl.granted
`

type BlockingResult struct {
	Blocked_pid        string
	Blocking_statement string
	Blocking_duration  string
	Blocking_pid       string
	Blocked_statement  string
	Blocked_duration   string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, BLOCKING_QUERY)
	if err != nil {
		return err
	}
	result, err := pgxv5.CollectRows[BlockingResult](rows)
	if err != nil {
		return err
	}

	table := "|blocked pid|blocking statement|blocking duration|blocking pid|blocked statement|blocked duration|\n|-|-|-|-|-|-|\n"
	for _, r := range result {
		// remove whitespace from query
		re := regexp.MustCompile(`\s+|\r+|\n+|\t+|\v`)
		blocking_statement := re.ReplaceAllString(r.Blocking_statement, " ")
		blocked_statement := re.ReplaceAllString(r.Blocked_statement, " ")

		// escape pipes in query
		re = regexp.MustCompile(`\|`)
		blocking_statement = re.ReplaceAllString(r.Blocking_statement, `\|`)
		blocked_statement = re.ReplaceAllString(r.Blocked_statement, `\|`)
		table += fmt.Sprintf("|`%v`|`%v`|`%v`|`%v`|%s|`%v`|\n", r.Blocked_pid, blocking_statement, r.Blocking_duration, r.Blocking_pid, blocked_statement, r.Blocked_duration)
	}
	return list.RenderTable(table)
}
