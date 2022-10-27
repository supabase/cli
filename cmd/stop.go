package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/stop"
)

var (
	backup bool

	stopCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "stop",
		Short:   "Stop all local Supabase containers",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return stop.Run(ctx, backup, afero.NewOsFs())
		},
	}
)

func init() {
	stopCmd.Flags().BoolVar(&backup, "backup", false, "Backs up the current database before stopping.")
	rootCmd.AddCommand(stopCmd)
}
