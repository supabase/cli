package db_stats

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

//go:embed db_stats.sql
var DBStatsQuery string

type Result struct {
	Database_size          string
	Total_index_size       string
	Total_table_size       string
	Total_toast_size       string
	Time_since_stats_reset string
	Index_hit_rate         string
	Table_hit_rate         string
	WAL_size               string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, DBStatsQuery, reset.LikeEscapeSchema(utils.InternalSchemas), config.Database)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|Name|Database Size|Total Index Size|Total Table Size|Total Toast Size|Time Since Stats Reset|Index Hit Rate|Table Hit Rate|WAL Size|\n|-|-|-|-|-|-|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|\n", config.Database, r.Database_size, r.Total_index_size, r.Total_table_size, r.Total_toast_size, r.Time_since_stats_reset, r.Index_hit_rate, r.Table_hit_rate, r.WAL_size)
	}
	return list.RenderTable(table)
}
