package cmd

import (
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
	"github.com/supabase/cli/internal/utils"
)

var (
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
	flags.StringSliceVarP(&excludedContainers, "exclude", "x", []string{}, "Names of containers to not start. ["+excludableContainers()+"]")
	rootCmd.AddCommand(startCmd)
}

func excludableContainers() string {
	names := []string{}
	for _, image := range utils.ServiceImages {
		names = append(names, utils.ShortContainerImageName(image))
	}
	return strings.Join(names, ", ")
}
