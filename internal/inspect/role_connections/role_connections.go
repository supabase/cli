package role_connections

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

//go:embed role_connections.sql
var RoleConnectionsQuery string

type Result struct {
	Rolname            string
	Active_connections int
	Connection_limit   int
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, RoleConnectionsQuery)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|Role Name|Active connction|\n|-|-|\n"
	sum := 0
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%d`|\n", r.Rolname, r.Active_connections)
		sum += r.Active_connections
	}

	if err := list.RenderTable(table); err != nil {
		return err
	}

	if len(result) > 0 {
		fmt.Printf("\nActive connections %d/%d\n\n", sum, result[0].Connection_limit)
	}

	if matches := utils.ProjectHostPattern.FindStringSubmatch(config.Host); len(matches) == 4 {
		fmt.Println("Go to the dashboard for more here:")
		fmt.Printf("https://app.supabase.com/project/%s/database/roles\n", matches[2])
	}

	return nil
}
