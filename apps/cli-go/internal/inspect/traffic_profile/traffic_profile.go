package traffic_profile

import (
	"context"
	_ "embed"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgxv5"
)

//go:embed traffic_profile.sql
var TrafficProfileQuery string

type Result struct {
	Schemaname     string
	Table_name     string
	Blocks_read    int64
	Write_tuples   int64
	Blocks_write   float64
	Activity_ratio string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, TrafficProfileQuery)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|Schema|Table|Blocks Read|Write Tuples|Blocks Write|Activity Ratio|\n|-|-|-|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%s`|`%d`|`%d`|`%.1f`|`%s`|\n",
			r.Schemaname, r.Table_name, r.Blocks_read, r.Write_tuples, r.Blocks_write, r.Activity_ratio)
	}
	return utils.RenderTable(table)
}
