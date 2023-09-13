package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/version"
)

var (
	versionCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "version",
		Short:   "Show versions of all Supabase services",
		RunE: func(cmd *cobra.Command, args []string) error {
			return version.Run(cmd.Context(), afero.NewOsFs())
		},
	}
)

func init() {
	rootCmd.AddCommand(versionCmd)
}
