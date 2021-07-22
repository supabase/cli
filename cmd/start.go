package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
)

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "FIXME",
	Long:  `FIXME`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return start.Start()
	},
}

func init() {
	rootCmd.AddCommand(startCmd)
}
