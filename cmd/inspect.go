package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/inspect/blocking"
	"github.com/supabase/cli/internal/inspect/cache"
	"github.com/supabase/cli/internal/inspect/calls"
	"github.com/supabase/cli/internal/inspect/index_sizes"
	"github.com/supabase/cli/internal/inspect/index_usage"
	"github.com/supabase/cli/internal/inspect/locks"
	"github.com/supabase/cli/internal/inspect/outliers"
	"github.com/supabase/cli/internal/inspect/replication_slots"
	"github.com/supabase/cli/internal/inspect/table_index_sizes"
	"github.com/supabase/cli/internal/inspect/table_sizes"
	"github.com/supabase/cli/internal/inspect/total_index_size"
	"github.com/supabase/cli/internal/inspect/total_table_sizes"
	"github.com/supabase/cli/internal/inspect/unused_indexes"
)

var (
	inspectCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "inspect",
		Short:   "Tools to inspect your Supabase Database",
	}

	inspectDBCmd = &cobra.Command{
		Use:   "db",
		Short: "Tools to inspect your Supabase ds",
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

	inspectOutliersCmd = &cobra.Command{
		Use:   "outliers",
		Short: "Shows queries from pg_stat_statements ordered by total execution time",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return outliers.Run(ctx, dbConfig, fsys)
		},
	}

	inspectCallsCmd = &cobra.Command{
		Use:   "calls",
		Short: "Shows queries from pg_stat_statements ordered by total times called",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return calls.Run(ctx, dbConfig, fsys)
		},
	}

	inspectTotalIndexSizeCmd = &cobra.Command{
		Use:   "total-index-size",
		Short: "Shows total size of all indexes",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return total_index_size.Run(ctx, dbConfig, fsys)
		},
	}

	inspectIndexSizesCmd = &cobra.Command{
		Use:   "index-sizes",
		Short: "Shows index sizes of individual indexes",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return index_sizes.Run(ctx, dbConfig, fsys)
		},
	}

	inspectTableSizesCmd = &cobra.Command{
		Use:   "table-sizes",
		Short: "Shows table sizes of individual tables without their index sizes",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return table_sizes.Run(ctx, dbConfig, fsys)
		},
	}

	inspectTableIndexSizesCmd = &cobra.Command{
		Use:   "table-index-sizes",
		Short: "Shows index sizes of individual tables",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return table_index_sizes.Run(ctx, dbConfig, fsys)
		},
	}

	inspectTotalTableSizesCmd = &cobra.Command{
		Use:   "total-table-sizes",
		Short: "Shows total table sizes, including table index sizes",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return total_table_sizes.Run(ctx, dbConfig, fsys)
		},
	}

	inspectUnusedIndexesCmd = &cobra.Command{
		Use:   "unused-indexes",
		Short: "Show indexes with low usage",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return unused_indexes.Run(ctx, dbConfig, fsys)
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
	inspectDBCmd.AddCommand(inspectOutliersCmd)
	inspectDBCmd.AddCommand(inspectCallsCmd)
	inspectDBCmd.AddCommand(inspectTotalIndexSizeCmd)
	inspectDBCmd.AddCommand(inspectIndexSizesCmd)
	inspectDBCmd.AddCommand(inspectTableSizesCmd)
	inspectDBCmd.AddCommand(inspectTableIndexSizesCmd)
	inspectDBCmd.AddCommand(inspectTotalTableSizesCmd)
	inspectDBCmd.AddCommand(inspectUnusedIndexesCmd)
	rootCmd.AddCommand(inspectCmd)
}
