package blocking

import (
	"context"
	_ "embed"
	"fmt"
	"regexp"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgxv5"
)

//go:embed blocking.sql
var BlockingQuery string

type Result struct {
	Blocked_pid        int
	Blocking_statement string
	Blocking_duration  string
	Blocking_pid       int
	Blocked_statement  string
	Blocked_duration   string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// Ref: https://github.com/heroku/heroku-pg-extras/blob/main/commands/blocking.js#L7
	rows, err := conn.Query(ctx, BlockingQuery)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
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
		blocking_statement = re.ReplaceAllString(blocking_statement, `\|`)
		blocked_statement = re.ReplaceAllString(blocked_statement, `\|`)
		table += fmt.Sprintf("|`%d`|`%s`|`%s`|`%d`|%s|`%s`|\n", r.Blocked_pid, blocking_statement, r.Blocking_duration, r.Blocking_pid, blocked_statement, r.Blocked_duration)
	}
	return list.RenderTable(table)
}
