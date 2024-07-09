package cache

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

//go:embed cache.sql
var CacheQuery string

type Result struct {
	Name  string
	Ratio float64
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Ref: https://github.com/heroku/heroku-pg-extras/blob/main/commands/cache_hit.js#L7
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, CacheQuery)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}
	// TODO: implement a markdown table marshaller
	table := "|Name|Ratio|OK?|Explanation|\n|-|-|-|-|\n"
	for _, r := range result {
		ok := "Yup!"
		if r.Ratio < 0.94 {
			ok = "Maybe not..."
		}
		var explanation string
		if r.Name == "index hit rate" {
			explanation = "This is the ratio of index hits to index scans. If this ratio is low, it means that the database is not using indexes effectively. Check the `index-usage` command for more info."
		} else if r.Name == "table hit rate" {
			explanation = "This is the ratio of table hits to table scans. If this ratio is low, it means that your queries are not finding the data effectively. Check your query performance and it might be worth increasing your compute."
		}
		table += fmt.Sprintf("|`%s`|`%.6f`|`%s`|`%s`|\n", r.Name, r.Ratio, ok, explanation)
	}
	return list.RenderTable(table)
}
