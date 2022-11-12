package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/status"
)

var statusCmd = &cobra.Command{
	GroupID: groupLocalDev,
	Use:     "status",
	Short:   "Show status of local Supabase containers",
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
		return status.Run(ctx, afero.NewOsFs())
	},
}

func init() {
	rootCmd.AddCommand(statusCmd)
}
