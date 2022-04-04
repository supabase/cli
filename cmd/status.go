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
		showKeys := false

		if useFullId, err := cmd.Flags().GetBool("full-id"); err == nil {
			useShortId = !useFullId
		}

		if _showKeys, err := cmd.Flags().GetBool("show-keys"); err == nil {
			showKeys = _showKeys
		}

		return status.Run(useShortId, showKeys)
	},
}

func init() {
	statusCmd.Flags().Bool("full-id", false, "Display full id")
	statusCmd.Flags().Bool("show-keys", false, "Display supabase keys")
	rootCmd.AddCommand(statusCmd)
}
