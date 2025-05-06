package locks

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

//go:embed locks.sql
var LocksQuery string

type Result struct {
	Pid           int
	Relname       string
	Transactionid string
	Granted       bool
	Stmt          string
	Age           string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, LocksQuery)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|pid|relname|transaction id|granted|stmt|age|\n|-|-|-|-|-|-|\n"
	for _, r := range result {
		// remove whitespace from query
		re := regexp.MustCompile(`\s+|\r+|\n+|\t+|\v`)
		stmt := re.ReplaceAllString(r.Stmt, " ")

		// escape pipes in query
		re = regexp.MustCompile(`\|`)
		stmt = re.ReplaceAllString(stmt, `\|`)
		table += fmt.Sprintf("|`%d`|`%s`|`%s`|`%t`|%s|`%s`|\n", r.Pid, r.Relname, r.Transactionid, r.Granted, stmt, r.Age)
	}
	return list.RenderTable(table)
}
