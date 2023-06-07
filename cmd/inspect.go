package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/inspect/cache"
	"github.com/supabase/cli/internal/inspect/replication_slots"
	"github.com/supabase/cli/internal/inspect/index_usage"
)

var (
	inspectCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "inspect",
		Short:   "Tools to inspect your Supabase Database",
	}

	inspectCacheHitCmd = &cobra.Command{
		Use:   "db:cache-hit",
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
		Use:   "db:replication-slots",
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
		Use:   "db:index-usage",
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
)

func init() {
	inspectFlags := inspectCmd.PersistentFlags()
	inspectFlags.StringVar(&dbUrl, "db-url", "", "connect using the specified database url")
	inspectCmd.AddCommand(inspectCacheHitCmd)
	inspectCmd.AddCommand(inspectReplicationSlotsCmd)
	inspectCmd.AddCommand(inspectIndexUsageCmd)
	rootCmd.AddCommand(inspectCmd)
}
