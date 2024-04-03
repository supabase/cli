package cmd

import (
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
	"github.com/supabase/cli/internal/utils"
)

var (
	allowedContainers  = start.ExcludableContainers()
	excludedContainers []string
	ignoreHealthCheck  bool
	preview            bool

	startCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "start [service] ...",
		Short:   "Start containers for Supabase local development",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Add job images for backwards compatibility
			excluded := make(map[string]bool, len(allowedContainers)+len(utils.JobImages))
			for _, c := range allowedContainers {
				excluded[c] = len(args) > 0
			}
			for _, image := range utils.JobImages {
				c := utils.ShortContainerImageName(image)
				excluded[c] = len(args) > 0
			}
			for _, c := range args {
				if _, ok := excluded[c]; !ok {
					utils.CmdSuggestion = suggestServiceName(allowedContainers)
					return errors.New("Invalid service name: " + c)
				}
				excluded[c] = false
			}
			for _, c := range excludedContainers {
				if _, ok := excluded[c]; !ok {
					utils.CmdSuggestion = suggestServiceName(allowedContainers)
					return errors.New("Invalid service name: " + c)
				}
				excluded[c] = true
			}
			return start.Run(cmd.Context(), afero.NewOsFs(), excluded, ignoreHealthCheck)
		},
	}
)

func init() {
	flags := startCmd.Flags()
	names := strings.Join(allowedContainers, ",")
	flags.StringSliceVarP(&excludedContainers, "exclude", "x", []string{}, "Names of containers to not start. ["+names+"]")
	flags.BoolVar(&ignoreHealthCheck, "ignore-health-check", false, "Ignore unhealthy services and exit 0")
	flags.BoolVar(&preview, "preview", false, "Connect to feature preview branch")
	cobra.CheckErr(flags.MarkHidden("preview"))
	rootCmd.AddCommand(startCmd)
}

func suggestServiceName(services []string) string {
	return fmt.Sprintf("Must match one of these services: [%s]", strings.Join(services, ","))
}
