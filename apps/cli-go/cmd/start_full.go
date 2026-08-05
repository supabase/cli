//go:build !bundled

package cmd

// runStart's full implementation, backed by internal/start. Compiled by
// default (plain `go build`/`go test`); excluded from the bundled/release
// build via the "bundled" tag -- see cmd/start_bundled.go and
// apps/cli/docs/binary-distribution.md § Bundled build tag (CLI-1966).

import (
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/start"
	"github.com/supabase/cli/internal/utils"
)

func validateExcludedContainers(excludedContainers []string) {
	// Validate excluded containers. Uses the tag-neutral excludableContainers
	// (cmd/start.go), not start.ExcludableContainers, so this stays in sync
	// with the --exclude flag's own help text in both builds by construction.
	validContainers := excludableContainers()
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

func runStart(cmd *cobra.Command, excludedContainers []string, ignoreHealthCheck bool) error {
	validateExcludedContainers(excludedContainers)
	return start.Run(cmd.Context(), afero.NewOsFs(), excludedContainers, ignoreHealthCheck)
}
