//go:build bundled

package cmd

// runStart's bundled-build stub (CLI-1966). internal/start is unreachable
// from the TypeScript CLI (native TS `start` talks to Docker directly) but
// pulls in a large exclusive dependency tree, so the bundled/release build
// excludes it entirely rather than importing it just to leave it unused --
// see cmd/start_full.go and apps/cli/docs/binary-distribution.md § Bundled
// build tag for the full rationale and measured size impact.
//
// TODO(CLI-1965): once shell completion is ported to TypeScript and no
// longer needs the `__complete` passthrough into this binary, delete this
// file (and the `startCmd` registration in cmd/start.go) entirely instead
// of stubbing it.

import (
	"errors"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/utils"
)

// The error text is asserted verbatim by .github/workflows/cli-go-ci.yml's
// bundled-build check -- update both together.
func runStart(_ *cobra.Command, _ []string, _ bool) error {
	// Suppress root's default "--debug to troubleshoot" suggestion: this is
	// a compile-time stub, not a runtime failure, so --debug can't help.
	utils.CmdSuggestion = fmt.Sprintf("Run %s from the Supabase CLI instead of invoking this binary directly.", utils.Aqua("supabase start"))
	return errors.New("start is not available in supabase-go; the Supabase CLI's start command talks to Docker directly and does not use this binary")
}
