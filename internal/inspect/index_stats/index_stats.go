package index_stats

import (
	"context"
	_ "embed"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgxv5"
)

//go:embed index_stats.sql
var IndexStatsQuery string

type Result struct {
	Name         string
	Size         string
	Percent_used string
	Index_scans  int64
	Seq_scans    int64
	Unused       bool
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, IndexStatsQuery, reset.LikeEscapeSchema(utils.InternalSchemas))
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|Name|Size|Percent used|Index scans|Seq scans|Unused|\n|-|-|-|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|`%d`|`%d`|`%t`|\n", r.Name, r.Size, r.Percent_used, r.Index_scans, r.Seq_scans, r.Unused)
	}
	return list.RenderTable(table)
}
