package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/deploy"
)

var deployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "FIXME",
	Long:  `FIXME`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return deploy.Deploy()
	},
}

func init() {
	rootCmd.AddCommand(deployCmd)
}
