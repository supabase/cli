package bloat

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

//go:embed bloat.sql
var BloatQuery string

type Result struct {
	Type  string
	Name  string
	Bloat string
	Waste string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, BloatQuery, reset.LikeEscapeSchema(utils.InternalSchemas))
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|Type|Name|Bloat|Waste\n|-|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|`%s`|\n", r.Type, r.Name, r.Bloat, r.Waste)
	}
	return list.RenderTable(table)
}
