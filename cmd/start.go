package cmd

import (
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	allowedContainers  = start.ExcludableContainers()
	excludedContainers []string
	ignoreHealthCheck  bool
	preview            bool

	startCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "start",
		Short:   "Start containers for Supabase local development",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if preview {
				projectRef, err := utils.LoadProjectRef(fsys)
				if err != nil {
					return err
				}
				flags.ProjectRef = projectRef
			}
			return start.Run(cmd.Context(), fsys, excludedContainers, ignoreHealthCheck, flags.ProjectRef, dbUrl)
		},
	}
)

func init() {
	flags := startCmd.Flags()
	names := strings.Join(allowedContainers, ",")
	flags.StringSliceVarP(&excludedContainers, "exclude", "x", []string{}, "Names of containers to not start. ["+names+"]")
	flags.BoolVar(&ignoreHealthCheck, "ignore-health-check", false, "Ignore unhealthy services and exit 0")
	// flags.StringVar(&dbUrl, "db-url", "", "Connect to the specified database url")
	flags.BoolVar(&preview, "preview", false, "Connect to feature preview branch")
	rootCmd.AddCommand(startCmd)
}
