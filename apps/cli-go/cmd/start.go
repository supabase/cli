package cmd

// The "start" command's registration, flags, and validation are tag-neutral
// and shared by both the full and bundled builds so its command/flag surface
// can never drift between them -- only runStart's implementation differs
// (see cmd/start_full.go, cmd/start_bundled.go, and
// apps/cli/docs/binary-distribution.md § Bundled build tag for the full
// CLI-1966 rationale).

import (
	"strings"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

// excludableContainers lists the container names valid for the --exclude
// flag. Duplicated from internal/start.ExcludableContainers (rather than
// calling it) because this file must stay importable without pulling in
// internal/start's dependency tree in the bundled build. Keep in sync with
// internal/start/start.go.
func excludableContainers() []string {
	names := []string{}
	for _, image := range config.Images.Services() {
		names = append(names, utils.ShortContainerImageName(image))
	}
	return names
}

var (
	allowedContainers  = excludableContainers()
	excludedContainers []string
	ignoreHealthCheck  bool
	preview            bool

	startCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "start",
		Short:   "Start containers for Supabase local development",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runStart(cmd, excludedContainers, ignoreHealthCheck)
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
