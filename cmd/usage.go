package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/usage/cache"
)

var (
	usageCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "usage",
		Short:   "Show usage statistics about Supabase project",
	}

	usageCacheHitCmd = &cobra.Command{
		Use:   "cache",
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
)

func init() {
	usageFlags := usageCmd.PersistentFlags()
	usageFlags.StringVar(&dbUrl, "db-url", "", "connect using the specified database url")
	usageCmd.AddCommand(usageCacheHitCmd)
	rootCmd.AddCommand(usageCmd)
}
