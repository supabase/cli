package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
)

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "Start containers for Supabase local development",
	RunE: func(cmd *cobra.Command, args []string) error {
		return start.Run()
	},
}

func init() {
	rootCmd.AddCommand(startCmd)
}
