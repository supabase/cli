package table_record_counts

import (
	"context"
	"fmt"

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
  relname AS name,
  n_live_tup AS estimated_count
FROM
  pg_stat_user_tables
ORDER BY
  n_live_tup DESC;`

type Result struct {
	Name            string
	Estimated_count string
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

	table := "|Name|Estimated count|\n|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%s`|\n", r.Name, r.Estimated_count)
	}
	return list.RenderTable(table)
}
