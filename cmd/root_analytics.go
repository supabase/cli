package cmd

import (
	"os"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/supabase/cli/internal/telemetry"
	"github.com/supabase/cli/internal/utils/agent"
	"golang.org/x/term"
)

func commandAnalyticsContext(cmd *cobra.Command) telemetry.CommandContext {
	return telemetry.CommandContext{
		RunID:      uuid.NewString(),
		Command:    commandName(cmd),
		FlagsUsed:  changedFlags(cmd),
		FlagValues: map[string]any{},
	}
}

func commandName(cmd *cobra.Command) string {
	path := strings.TrimSpace(cmd.CommandPath())
	rootName := strings.TrimSpace(cmd.Root().Name())
	if path == rootName || path == "" {
		return rootName
	}
	return strings.TrimSpace(strings.TrimPrefix(path, rootName))
}

func changedFlags(cmd *cobra.Command) []string {
	seen := make(map[string]struct{})
	var result []string
	collect := func(flags *pflag.FlagSet) {
		if flags == nil {
			return
		}
		flags.Visit(func(flag *pflag.Flag) {
			if _, ok := seen[flag.Name]; ok {
				return
			}
			seen[flag.Name] = struct{}{}
			result = append(result, flag.Name)
		})
	}
	for current := cmd; current != nil; current = current.Parent() {
		collect(current.PersistentFlags())
	}
	collect(cmd.Flags())
	sort.Strings(result)
	return result
}

func telemetryIsCI() bool {
	return os.Getenv("CI") != "" ||
		os.Getenv("GITHUB_ACTIONS") != "" ||
		os.Getenv("BUILDKITE") != "" ||
		os.Getenv("TF_BUILD") != "" ||
		os.Getenv("JENKINS_URL") != "" ||
		os.Getenv("GITLAB_CI") != ""
}

func telemetryIsTTY() bool {
	return term.IsTerminal(int(os.Stdout.Fd()))
}

func telemetryAITool() string {
	return agent.GetAgentName()
}
