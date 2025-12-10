package replication

import (
	"context"
	_ "embed"
	"fmt"
	"time"

	"github.com/go-errors/errors"
	"github.com/inhies/go-bytesize"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgxv5"
)

//go:embed replication.sql
var replicationQuery string

type ReplicationStat struct {
	WalKeepSize              string `db:"wal_keep_size"`
	MaxWalSize               string `db:"max_wal_size"`
	MinWalSize               string `db:"min_wal_size"`
	MaxSlotWalKeepSize       string `db:"max_slot_wal_keep_size"`
	WalSenderTimeout         string `db:"wal_sender_timeout"`
	MaxStandbyStreamingDelay string `db:"max_standby_streaming_delay"`
	CheckpointTimeout        string `db:"checkpoint_timeout"`
	CurrentWalLsn            string `db:"current_wal_lsn"`
}

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, sleepDuration time.Duration, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	rows, err := conn.Query(ctx, replicationQuery)
	if err != nil {
		return errors.Errorf("failed to query replication stats: %w", err)
	}
	stats1, err := pgxv5.CollectRows[ReplicationStat](rows)
	if err != nil {
		return err
	}
	if len(stats1) == 0 {
		return errors.New("no replication stats found")
	}

	// Sleep based on --duration flag (default: 1min)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(sleepDuration):
	}

	var walDiff float64
	if err := conn.QueryRow(ctx, "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1)", stats1[0].CurrentWalLsn).Scan(&walDiff); err != nil {
		return errors.Errorf("failed to calculate WAL diff: %w", err)
	}
	walRatePerMinute := walDiff / sleepDuration.Minutes()

	fmt.Printf("wal_generation_rate: %s/min\n", bytesize.New(walRatePerMinute).String())
	fmt.Println()

	table := "|Setting|Current Value|Recommended Value|Reason|\n|-|-|-|-|\n"

	addRow := func(setting, current, recommended, reason string) {
		if recommended == "" {
			recommended = "-"
		}
		if reason == "" {
			reason = "-"
		}
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|`%s`|\n", setting, current, recommended, reason)
	}

	// WAL Keep Size
	msgKeep, reasonKeep := "", ""
	if walKeepSize, err := bytesize.Parse(stats1[0].WalKeepSize); err == nil && walRatePerMinute > 0 {
		duration := time.Duration(float64(walKeepSize) / walRatePerMinute * float64(time.Minute))
		if duration < 1*time.Hour {
			requiredSize := bytesize.ByteSize(walRatePerMinute * 60)
			msgKeep = fmt.Sprintf("> %s", requiredSize.String())
			reasonKeep = fmt.Sprintf("Retains only ~%s at current rate (target 1h)", duration.Round(time.Minute))
		}
	}
	addRow("wal_keep_size", stats1[0].WalKeepSize, msgKeep, reasonKeep)

	// Max WAL Size
	msgMaxWal, reasonMaxWal := "", ""
	if maxWalSize, err := bytesize.Parse(stats1[0].MaxWalSize); err == nil && walRatePerMinute > 0 {
		duration := time.Duration(float64(maxWalSize) / walRatePerMinute * float64(time.Minute))
		if duration < 1*time.Hour {
			requiredSize := bytesize.ByteSize(walRatePerMinute * 60)
			msgMaxWal = fmt.Sprintf("> %s", requiredSize.String())
			reasonMaxWal = fmt.Sprintf("Fills in ~%s at current rate (target 1h)", duration.Round(time.Minute))
		}
	}
	addRow("max_wal_size", stats1[0].MaxWalSize, msgMaxWal, reasonMaxWal)

	// Max Slot WAL Keep Size
	msgSlotKeep, reasonSlotKeep := "", ""
	if stats1[0].MaxSlotWalKeepSize == "-1" {
		msgSlotKeep = "set a limit"
		reasonSlotKeep = "Unlimited size can fill disk if replica disconnects"
	} else if maxSlotWalKeepSize, err := bytesize.Parse(stats1[0].MaxSlotWalKeepSize); err == nil && walRatePerMinute > 0 {
		duration := time.Duration(float64(maxSlotWalKeepSize) / walRatePerMinute * float64(time.Minute))
		if duration < 1*time.Hour {
			requiredSize := bytesize.ByteSize(walRatePerMinute * 60)
			msgSlotKeep = fmt.Sprintf("> %s", requiredSize.String())
			reasonSlotKeep = fmt.Sprintf("Retains only ~%s at current rate (target 1h)", duration.Round(time.Minute))
		}
	}
	addRow("max_slot_wal_keep_size", stats1[0].MaxSlotWalKeepSize, msgSlotKeep, reasonSlotKeep)

	// Timeouts
	addRow("wal_sender_timeout", stats1[0].WalSenderTimeout, "", "-")
	addRow("max_standby_streaming_delay", stats1[0].MaxStandbyStreamingDelay, "", "-")

	// TODO: check if some of these things could/should be done via CSVQ
	// TODO: offer user to apply recommended changes via the CLI (defaulting to no restart)
	return utils.RenderTable(table)
}
