package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/status"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show status of local Supabase containers",
	RunE: func(cmd *cobra.Command, args []string) error {
		return status.Run()
	},
}

func init() {
	rootCmd.AddCommand(statusCmd)
}
