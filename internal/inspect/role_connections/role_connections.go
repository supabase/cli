package role_connections

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

const QUERY = `
select
  rolname,
  (
    select
      count(*)
    from
      pg_stat_activity
    where
      pg_roles.rolname = pg_stat_activity.usename
  ) as active_connections,
  case when rolconnlimit = -1 then current_setting('max_connections') :: int8
       else rolconnlimit
  end as connection_limit
from
  pg_roles
order by 2 desc`

type Result struct {
	Rolname            string
	Active_connections int
	Connection_limit   int
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, QUERY)
	if err != nil {
		return err
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

	err = list.RenderTable(table)
	if err != nil {
		fmt.Println(err)
		return err
	}

	if len(result) > 0 {
		fmt.Printf("\nActive connections %d/%d\n", sum, result[0].Connection_limit)
	}

	return nil
}
