package cmd

import (
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/sandbox"
	"github.com/supabase/cli/internal/start"
	"github.com/supabase/cli/internal/utils"
)

func validateExcludedContainers(excludedContainers []string) {
	// Validate excluded containers
	validContainers := start.ExcludableContainers()
	var invalidContainers []string

	for _, e := range excludedContainers {
		if !slices.Contains(validContainers, e) {
			invalidContainers = append(invalidContainers, e)
		}
	}

	if len(invalidContainers) > 0 {
		// Sort the names list so it's easier to visually spot the one you looking for
		sort.Strings(validContainers)
		warning := fmt.Sprintf("%s The following container names are not valid to exclude: %s\nValid containers to exclude are: %s\n",
			utils.Yellow("WARNING:"),
			utils.Aqua(strings.Join(invalidContainers, ", ")),
			utils.Aqua(strings.Join(validContainers, ", ")))
		fmt.Fprint(os.Stderr, warning)
	}
}

var (
	allowedContainers   = start.ExcludableContainers()
	excludedContainers  []string
	ignoreHealthCheck   bool
	preview             bool
	sandboxMode         bool
	sandboxNoDetach     bool

	startCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "start",
		Short:   "Start containers for Supabase local development",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Sandbox mode uses process-compose with native binaries instead of Docker Compose
			if sandboxMode {
				return sandbox.Run(cmd.Context(), afero.NewOsFs(), !sandboxNoDetach)
			}
			validateExcludedContainers(excludedContainers)
			return start.Run(cmd.Context(), afero.NewOsFs(), excludedContainers, ignoreHealthCheck)
		},
	}
)

func init() {
	flags := startCmd.Flags()
	names := strings.Join(allowedContainers, ",")
	flags.StringSliceVarP(&excludedContainers, "exclude", "x", []string{}, "Names of containers to not start. ["+names+"]")
	flags.BoolVar(&ignoreHealthCheck, "ignore-health-check", false, "Ignore unhealthy services and exit 0")
	flags.BoolVar(&preview, "preview", false, "Connect to feature preview branch")
	flags.BoolVar(&sandboxMode, "sandbox", false, "Run in sandbox mode using native binaries (experimental)")
	flags.BoolVar(&sandboxNoDetach, "no-detach", false, "Run sandbox in foreground (don't detach)")
	cobra.CheckErr(flags.MarkHidden("preview"))
	rootCmd.AddCommand(startCmd)
}
