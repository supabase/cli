package cmd

import (
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
)

var (
	allowedContainers  = start.ExcludableContainers()
	excludedContainers []string

	startCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "start",
		Short:   "Start containers for Supabase local development",
		RunE: func(cmd *cobra.Command, args []string) error {
			return start.Run(cmd.Context(), afero.NewOsFs(), excludedContainers)
		},
	}
)

func init() {
	flags := startCmd.Flags()
	names := strings.Join(allowedContainers, ", ")
	flags.StringSliceVarP(&excludedContainers, "exclude", "x", []string{}, "Names of containers to not start. ["+names+"]")
	rootCmd.AddCommand(startCmd)
}
