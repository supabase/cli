package index_sizes

import (
	"context"
	"fmt"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/pgxv5"
)

const INDEX_USAGE_QUERY = `
SELECT c.relname AS name,
  pg_size_pretty(sum(c.relpages::bigint*8192)::bigint) AS size
FROM pg_class c
LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
AND n.nspname !~ '^pg_toast'
AND c.relkind='i'
GROUP BY c.relname
ORDER BY sum(c.relpages) DESC;`

type IndexUsageResult struct {
	Name string
	Size string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, INDEX_USAGE_QUERY)
	if err != nil {
		return err
	}
	result, err := pgxv5.CollectRows[IndexUsageResult](rows)
	if err != nil {
		return err
	}

	table := "|Name|size|\n|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%s`|\n", r.Name, r.Size)
	}
	return list.RenderTable(table)
}
