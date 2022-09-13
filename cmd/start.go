package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
)

var (
	useValueFile bool

	startCmd = &cobra.Command{
		Use:   "start",
		Short: "Start containers for Supabase local development",
		RunE: func(cmd *cobra.Command, args []string) error {
			return start.Run(cmd.Context(), useValueFile)
		},
	}
)

func init() {
	startFlags := startCmd.Flags()
	startFlags.BoolVar(&useValueFile, "value-file", false, "Outputs a file with key values")
	rootCmd.AddCommand(startCmd)
}
