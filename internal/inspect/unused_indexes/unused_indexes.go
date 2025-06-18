package unused_indexes

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

//go:embed unused_indexes.sql
var UnusedIndexesQuery string

type Result struct {
	Name        string
	Index       string
	Index_size  string
	Index_scans int64
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, UnusedIndexesQuery, reset.LikeEscapeSchema(utils.InternalSchemas))
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|Table|Index|Index Size|Index Scans\n|-|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|`%d`|\n", r.Name, r.Index, r.Index_size, r.Index_scans)
	}
	return list.RenderTable(table)
}
