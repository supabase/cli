package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/deploy"
)

var deployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "TODO",
	Long:  `TODO`,
	Run: func(cmd *cobra.Command, args []string) {
		deploy.Deploy()
	},
}

func init() {
	rootCmd.AddCommand(deployCmd)
}
