package replication

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestReplicationCommand(t *testing.T) {
	t.Run("inspects replication settings", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		conn := pgtest.NewConn()
		defer conn.Close(t)

		// Mock first query
		conn.Query(replicationQuery).
			Reply("SELECT 1", ReplicationStat{
				MaxWalSenders:            "10",
				MaxReplicationSlots:      "10",
				WalKeepSize:              "1GB",
				MaxWalSize:               "1GB",
				MinWalSize:               "80MB",
				MaxSlotWalKeepSize:       "1GB",
				WalSenderTimeout:         "60s",
				MaxStandbyStreamingDelay: "30s",
				CheckpointTimeout:        "5min",
				ActiveSlots:              2,
				ActiveSenders:            2,
				CurrentWalLsn:            "0/1000000",
			})


		// Mock diff query
		conn.Query("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1)", "0/1000000").
			Reply("SELECT 1", struct{ Diff float64 }{Diff: 16777216})

		// Run test
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		err := Run(ctx, dbConfig, fsys, time.Millisecond, conn.Intercept)
		assert.NoError(t, err)
	})

	t.Run("inspects standalone database (no replication)", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		conn := pgtest.NewConn()
		defer conn.Close(t)

		// Mock first query
		conn.Query(replicationQuery).
			Reply("SELECT 1", ReplicationStat{
				MaxWalSenders:            "10",
				MaxReplicationSlots:      "10",
				WalKeepSize:              "1GB",
				MaxWalSize:               "1GB",
				MinWalSize:               "80MB",
				MaxSlotWalKeepSize:       "-1",
				WalSenderTimeout:         "60s",
				MaxStandbyStreamingDelay: "30s",
				CheckpointTimeout:        "5min",
				ActiveSlots:              0,
				ActiveSenders:            0,
				CurrentWalLsn:            "0/1000000",
			})


		// Mock diff query (simulating 16MB diff)
		conn.Query("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1)", "0/1000000").
			Reply("SELECT 1", struct{ Diff float64 }{Diff: 16777216})

		err := Run(context.Background(), dbConfig, fsys, time.Millisecond, conn.Intercept)
		assert.NoError(t, err)
	})

	t.Run("throws error on connection failure", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		// Run test with invalid port to force connection error
		err := Run(context.Background(), pgconn.Config{}, fsys, time.Millisecond)
		assert.Error(t, err)
	})

	t.Run("suggests increasing WAL sizes under high load", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		conn := pgtest.NewConn()
		defer conn.Close(t)

		// Mock first query
		conn.Query(replicationQuery).
			Reply("SELECT 1", ReplicationStat{
				MaxWalSenders:            "10",
				MaxReplicationSlots:      "10",
				WalKeepSize:              "100MB",
				MaxWalSize:               "1GB",
				MinWalSize:               "80MB",
				MaxSlotWalKeepSize:       "1GB",
				WalSenderTimeout:         "60s",
				MaxStandbyStreamingDelay: "30s",
				CheckpointTimeout:        "5min",
				ActiveSlots:              2,
				ActiveSenders:            2,
				CurrentWalLsn:            "0/1000000",
			})


		// Mock diff query (32MB)
		conn.Query("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1)", "0/1000000").
			Reply("SELECT 1", struct{ Diff float64 }{Diff: 33554432})

		// Rate = 32MB / 1ms = 32GB/s
		err := Run(context.Background(), dbConfig, fsys, time.Millisecond, conn.Intercept)
		assert.NoError(t, err)
	})
}
