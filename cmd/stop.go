package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/stop"
)

var (
	stopCmd = &cobra.Command{
		Use:   "stop",
		Short: "Stop all local Supabase containers",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return stop.Run(ctx, afero.NewOsFs())
		},
	}
)

func init() {
	rootCmd.AddCommand(stopCmd)
}
