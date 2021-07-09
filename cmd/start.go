package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
)

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "TODO",
	Long:  `TODO`,
	Run: func(cmd *cobra.Command, args []string) {
		start.Start()
	},
}

func init() {
	rootCmd.AddCommand(startCmd)
}
