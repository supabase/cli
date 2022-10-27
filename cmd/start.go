package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
)

var startCmd = &cobra.Command{
	GroupID: groupLocalDev,
	Use:     "start",
	Short:   "Start containers for Supabase local development",
	RunE: func(cmd *cobra.Command, args []string) error {
		return start.Run(cmd.Context(), afero.NewOsFs())
	},
}

func init() {
	rootCmd.AddCommand(startCmd)
}
