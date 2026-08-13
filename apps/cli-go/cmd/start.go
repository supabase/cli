package cmd

// internal/start (Go's own `supabase start` implementation) was deleted
// outright (CLI-1966): it is unreachable from the TypeScript CLI, which
// talks to Docker directly for `start` and never delegates to this binary
// for it, and no other still-live TS->Go delegation seam (db test, db
// branch/remote, db diff --use-pgadmin/--use-pg-schema, db pull
// --experimental, the hidden db __catalog seam (baseline/declarative modes
// only -- the migrations mode was removed by CLI-1959, and the sibling
// hidden db __shadow seam was removed outright by CLI-1956) -- the sibling
// hidden db __db-bootstrap seam was removed outright by CLI-1955, once
// native `db reset --local` became its last remaining caller -- etc.) ever
// called into internal/start either -- see
// apps/cli/docs/binary-distribution.md § Removed commands for the full
// rationale. This command's registration and flags are kept only so this
// binary's cobra tree / `--help` / `__complete` output stays stable for
// anyone invoking supabase-go directly; RunE is a permanent stub. There is
// no `--exclude` validation here anymore (that lived in the now-deleted
// internal/start.validateExcludedContainers) -- the TS port owns that
// warning now (`legacy/commands/start/start.exclude.ts`).
//
// TODO(CLI-1965): once shell completion is ported to TypeScript and no
// longer needs the `__complete` passthrough into this binary, delete this
// file (and the `startCmd` registration) entirely.

import (
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

// excludableContainers lists the container names valid for the --exclude
// flag, matching the removed internal/start.ExcludableContainers so the
// flag's help text is unaffected by the deletion.
func excludableContainers() []string {
	names := []string{}
	for _, image := range config.Images.Services() {
		names = append(names, utils.ShortContainerImageName(image))
	}
	return names
}

// startCmd's flags are declared without bound vars (StringSliceP/Bool, not
// StringSliceVarP/BoolVar): RunE never reads a real value for any of them --
// it always fails -- so a bound var would just be a write-only sink left
// over from the deleted internal/start implementation that used to read
// them. The flags still parse and appear in --help/__complete identically.
var startCmd = &cobra.Command{
	GroupID: groupLocalDev,
	Use:     "start",
	Short:   "Start containers for Supabase local development",
	// The error text is asserted verbatim by TestStartIsUnavailable
	// (start_test.go) -- update both together.
	RunE: func(cmd *cobra.Command, args []string) error {
		// Suppress root's default "--debug to troubleshoot" suggestion:
		// this always fails, so --debug can't help.
		utils.CmdSuggestion = fmt.Sprintf("Run %s from the Supabase CLI instead of invoking this binary directly.", utils.Aqua("supabase start"))
		return errors.New("start is not available in supabase-go; the Supabase CLI's start command talks to Docker directly and does not use this binary")
	},
}

func init() {
	flags := startCmd.Flags()
	names := strings.Join(excludableContainers(), ",")
	flags.StringSliceP("exclude", "x", nil, "Names of containers to not start. ["+names+"]")
	flags.Bool("ignore-health-check", false, "Ignore unhealthy services and exit 0")
	flags.Bool("preview", false, "Connect to feature preview branch")
	cobra.CheckErr(flags.MarkHidden("preview"))
	rootCmd.AddCommand(startCmd)
}
