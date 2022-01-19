package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/stop"
)

var stopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the Supabase local development setup.",
	RunE: func(cmd *cobra.Command, args []string) error {
		return stop.Run()
	},
}

func init() {
	rootCmd.AddCommand(stopCmd)
}
