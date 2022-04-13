package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
	"github.com/supabase/cli/internal/stop"
)

var restartCmd = &cobra.Command{
	Use:   "restart",
	Short: "Restart the Supabase local development setup.",
	RunE: func(cmd *cobra.Command, args []string) error {
		stopErr := stop.Run()
		if stopErr != nil {
			return stopErr
		}
		return start.Run()
	},
}

func init() {
	rootCmd.AddCommand(restartCmd)
}
