package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/info"
)

var infoCmd = &cobra.Command{
	Use:   "info",
	Short: "Get Supabase local development info.",
	RunE: func(cmd *cobra.Command, args []string) error {
		return info.Run()
	},
}

func init() {
	rootCmd.AddCommand(infoCmd)
}
