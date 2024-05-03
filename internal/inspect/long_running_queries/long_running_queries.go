package long_running_queries

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/inspect"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/pgxv5"
)

type Result struct {
	Pid      int
	Duration string
	Query    string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, inspect.LONG_RUNNING_QUERY)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|pid|Duration|Query|\n|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%d`|`%s`|`%s`|\n", r.Pid, r.Duration, r.Query)
	}
	return list.RenderTable(table)
}
