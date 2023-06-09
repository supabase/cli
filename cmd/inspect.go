package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/inspect/cache"
	"github.com/supabase/cli/internal/inspect/replication_slots"
	"github.com/supabase/cli/internal/inspect/index_usage"
	"github.com/supabase/cli/internal/inspect/locks"
	"github.com/supabase/cli/internal/inspect/blocking"
)

var (
	inspectCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "inspect",
		Short:   "Tools to inspect your Supabase Database",
	}

	inspectDBCmd = &cobra.Command{
		Use:     "db",
		Short:   "Tools to inspect your Supabase ds",
	}

	inspectCacheHitCmd = &cobra.Command{
		Use:   "cache-hit",
		Short: "Shows cache hit rates for tables and indices",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return cache.Run(ctx, dbConfig, fsys)
		},
	}

	inspectReplicationSlotsCmd = &cobra.Command{
		Use:   "replication-slots",
		Short: "Shows information about replication slots on the database",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return replication_slots.Run(ctx, dbConfig, fsys)
		},
	}

	inspectIndexUsageCmd = &cobra.Command{
		Use:   "index-usage",
		Short: "Shows information about the efficiency of indexes",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return index_usage.Run(ctx, dbConfig, fsys)
		},
	}

	inspectLocksCmd = &cobra.Command{
		Use:   "locks",
		Short: "Shows queries which have taken out an exclusive lock on a relation",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return locks.Run(ctx, dbConfig, fsys)
		},
	}

	inspectBlockingCmd = &cobra.Command{
		Use:   "blocking",
		Short: "Shows queries that are holding locks and the queries that are waiting for them to be released",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return blocking.Run(ctx, dbConfig, fsys)
		},
	}
)

func init() {
	inspectFlags := inspectCmd.PersistentFlags()
	inspectFlags.StringVar(&dbUrl, "db-url", "", "connect using the specified database url")
	inspectCmd.AddCommand(inspectDBCmd)
	inspectDBCmd.AddCommand(inspectCacheHitCmd)
	inspectDBCmd.AddCommand(inspectReplicationSlotsCmd)
	inspectDBCmd.AddCommand(inspectIndexUsageCmd)
	inspectDBCmd.AddCommand(inspectLocksCmd)
	inspectDBCmd.AddCommand(inspectBlockingCmd)
	rootCmd.AddCommand(inspectCmd)
}
