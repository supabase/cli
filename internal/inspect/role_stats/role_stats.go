package role_stats

import (
	"context"
	_ "embed"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgxv5"
)

//go:embed role_stats.sql
var RoleStatsQuery string

type Result struct {
	Role_name          string
	Active_connections int
	Connection_limit   int
	Custom_config      string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, RoleStatsQuery)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|Role name|Active connections|Connection limit|Custom config|\n|-|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%d`|`%d`|`%s`|\n", r.Role_name, r.Active_connections, r.Connection_limit, r.Custom_config)
	}

	return list.RenderTable(table)
}
