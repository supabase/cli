package vacuum_stats

import (
	"context"
	_ "embed"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgxv5"
)

//go:embed vacuum_stats.sql
var VacuumStatsQuery string

type Result struct {
	Name                 string
	Last_vacuum          string
	Last_autovacuum      string
	Rowcount             string
	Dead_rowcount        string
	Autovacuum_threshold string
	Expect_autovacuum    string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, VacuumStatsQuery, reset.LikeEscapeSchema(utils.InternalSchemas))
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|Table|Last Vacuum|Last Auto Vacuum|Row count|Dead row count|Expect autovacuum?\n|-|-|-|-|-|-|\n"
	for _, r := range result {
		rowcount := strings.Replace(r.Rowcount, "-1", "No stats", 1)
		table += fmt.Sprintf("|`%s`|%s|%s|`%s`|`%s`|`%s`|\n", r.Name, r.Last_vacuum, r.Last_autovacuum, rowcount, r.Dead_rowcount, r.Expect_autovacuum)
	}
	return list.RenderTable(table)
}
