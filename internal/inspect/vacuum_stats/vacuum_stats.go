package vacuum_stats

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/pgxv5"
)

const QUERY = `
WITH table_opts AS (
  SELECT
    pg_class.oid, relname, nspname, array_to_string(reloptions, '') AS relopts
  FROM
     pg_class INNER JOIN pg_namespace ns ON relnamespace = ns.oid
), vacuum_settings AS (
  SELECT
    oid, relname, nspname,
    CASE
      WHEN relopts LIKE '%autovacuum_vacuum_threshold%'
        THEN substring(relopts, '.*autovacuum_vacuum_threshold=([0-9.]+).*')::integer
        ELSE current_setting('autovacuum_vacuum_threshold')::integer
      END AS autovacuum_vacuum_threshold,
    CASE
      WHEN relopts LIKE '%autovacuum_vacuum_scale_factor%'
        THEN substring(relopts, '.*autovacuum_vacuum_scale_factor=([0-9.]+).*')::real
        ELSE current_setting('autovacuum_vacuum_scale_factor')::real
      END AS autovacuum_vacuum_scale_factor
  FROM
    table_opts
)
SELECT
  vacuum_settings.nspname AS schema,
  vacuum_settings.relname AS table,
  coalesce(to_char(psut.last_vacuum, 'YYYY-MM-DD HH24:MI'), '') AS last_vacuum,
  coalesce(to_char(psut.last_autovacuum, 'YYYY-MM-DD HH24:MI'), '') AS last_autovacuum,
  to_char(pg_class.reltuples, '9G999G999G999') AS rowcount,
  to_char(psut.n_dead_tup, '9G999G999G999') AS dead_rowcount,
  to_char(autovacuum_vacuum_threshold
       + (autovacuum_vacuum_scale_factor::numeric * pg_class.reltuples), '9G999G999G999') AS autovacuum_threshold,
  CASE
    WHEN autovacuum_vacuum_threshold + (autovacuum_vacuum_scale_factor::numeric * pg_class.reltuples) < psut.n_dead_tup
    THEN 'yes'
    ELSE 'no'
  END AS expect_autovacuum
FROM
  pg_stat_user_tables psut INNER JOIN pg_class ON psut.relid = pg_class.oid
INNER JOIN vacuum_settings ON pg_class.oid = vacuum_settings.oid
ORDER BY
  case
    when pg_class.reltuples = -1 then 1
    else 0
  end,
  1`

type Result struct {
	Schema               string
	Table                string
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
	rows, err := conn.Query(ctx, QUERY)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}

	table := "|Schema|Table|Last Vacuum|Last Auto Vacuum|Row count|Dead row count|Expect autovacuum?\n|-|-|-|-|-|-|-|\n"
	for _, r := range result {
		rowcount := strings.Replace(r.Rowcount, "-1", "No stats", 1)
		table += fmt.Sprintf("|`%s`|`%s`|%s|%s|`%s`|`%s`|`%s`|\n", r.Schema, r.Table, r.Last_vacuum, r.Last_autovacuum, rowcount, r.Dead_rowcount, r.Expect_autovacuum)
	}
	return list.RenderTable(table)
}
