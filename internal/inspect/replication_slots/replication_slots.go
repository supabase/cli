package replication_slots

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

const REPLICATION_SLOTS_QUERY = `
SELECT
  s.slot_name,
  s.active,
  COALESCE(r.state, 'N/A') as state,
  CASE WHEN r.client_addr IS NULL
     THEN 'N/A'
     ELSE r.client_addr::text
  END replication_client_address,
  GREATEST(0, ROUND((redo_lsn-restart_lsn)/1024/1024/1024, 2)) as replication_lag_gb
FROM pg_control_checkpoint(), pg_replication_slots s
LEFT JOIN pg_stat_replication r ON (r.pid = s.active_pid);
`

type ReplicationSlotsResult struct {
	Slot_name  string
	Active string
	State string
	Replication_client_address string
	Replication_lag_gb string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, REPLICATION_SLOTS_QUERY)
	if err != nil {
		return err
	}
	result, err := pgxv5.CollectRows[ReplicationSlotsResult](rows)
	if err != nil {
		return err
	}
	// TODO: implement a markdown table marshaller
	table := "|Name|Active|State|Replication Client Address|Replication Lag GB|\n|-|-|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%v`|`%v`|`%v`|`%v`|\n", r.Slot_name, r.Active, r.State, r.Replication_client_address, r.Replication_lag_gb)
	}
	return list.RenderTable(table)
}
