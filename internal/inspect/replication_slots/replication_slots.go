package replication_slots

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

//go:embed replication_slots.sql
var ReplicationSlotsQuery string

type Result struct {
	Slot_name                  string
	Active                     bool
	State                      string
	Replication_client_address string
	Replication_lag_gb         string
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, ReplicationSlotsQuery)
	if err != nil {
		return errors.Errorf("failed to query rows: %w", err)
	}
	result, err := pgxv5.CollectRows[Result](rows)
	if err != nil {
		return err
	}
	// TODO: implement a markdown table marshaller
	table := "|Name|Active|State|Replication Client Address|Replication Lag GB|\n|-|-|-|-|-|\n"
	for _, r := range result {
		table += fmt.Sprintf("|`%s`|`%t`|`%s`|`%s`|`%s`|\n", r.Slot_name, r.Active, r.State, r.Replication_client_address, r.Replication_lag_gb)
	}
	return list.RenderTable(table)
}
