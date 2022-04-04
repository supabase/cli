package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/status"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Get Supabase local development status.",
	RunE: func(cmd *cobra.Command, args []string) error {
		useShortId := true

		if showFullId, err := cmd.Flags().GetBool("full-id"); err == nil {
			useShortId = !showFullId
		}

		return status.Run(useShortId)
	},
}

func init() {
	statusCmd.Flags().Bool("full-id", false, "Display full id")
	rootCmd.AddCommand(statusCmd)
}
