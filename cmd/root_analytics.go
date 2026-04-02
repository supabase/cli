package cmd

import (
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/supabase/cli/internal/telemetry"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/agent"
	"golang.org/x/term"
)

const (
	telemetrySafeValueAnnotation = "supabase.com/telemetry-safe-value"
	redactedTelemetryValue       = "<redacted>"
	maxTelemetryEnvValueLength   = 80
)

var telemetryEnvPresenceVars = []string{
	// AI tools signals
	"CURSOR_AGENT",
	"CURSOR_TRACE_ID",
	"GEMINI_CLI",
	"CODEX_SANDBOX",
	"CODEX_CI",
	"CODEX_THREAD_ID",
	"ANTIGRAVITY_AGENT",
	"AUGMENT_AGENT",
	"OPENCODE_CLIENT",
	"CLAUDECODE",
	"CLAUDE_CODE",
	"REPL_ID",
	"COPILOT_MODEL",
	"COPILOT_ALLOW_ALL",
	"COPILOT_GITHUB_TOKEN",
	// CI signals
	"CI",
	"GITHUB_ACTIONS",
	"BUILDKITE",
	"TF_BUILD",
	"JENKINS_URL",
	"GITLAB_CI",
	// Extra signals
	"GITHUB_TOKEN",
	"GITHUB_HEAD_REF",
	"BITBUCKET_CLONE_DIR",
	// Supabase environment signals
	"SUPABASE_ACCESS_TOKEN",
	"SUPABASE_HOME",
	"SYSTEMROOT",
	"SUPABASE_SSL_DEBUG",
	"SUPABASE_CA_SKIP_VERIFY",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NPM_CONFIG_REGISTRY",
	"SUPABASE_SERVICE_ROLE_KEY",
	"SUPABASE_PROJECT_ID",
	"SUPABASE_POSTGRES_URL",
	"SUPABASE_ENV",
}

var telemetryEnvValueVars = []string{
	"AI_AGENT",
	"CURSOR_EXTENSION_HOST_ROLE",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TERM_COLOR_MODE",
}

func commandAnalyticsContext(cmd *cobra.Command) telemetry.CommandContext {
	return telemetry.CommandContext{
		RunID:   uuid.NewString(),
		Command: commandName(cmd),
		Flags:   changedFlagValues(cmd),
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

func changedFlagValues(cmd *cobra.Command) map[string]any {
	flags := changedFlags(cmd)
	if len(flags) == 0 {
		return nil
	}
	values := make(map[string]any, len(flags))
	for _, flag := range flags {
		values[flag.Name] = telemetryFlagValue(flag)
	}
	return values
}

func changedFlags(cmd *cobra.Command) []*pflag.Flag {
	seen := make(map[string]struct{})
	var result []*pflag.Flag
	collect := func(flags *pflag.FlagSet) {
		if flags == nil {
			return
		}
		flags.Visit(func(flag *pflag.Flag) {
			if _, ok := seen[flag.Name]; ok {
				return
			}
			seen[flag.Name] = struct{}{}
			result = append(result, flag)
		})
	}
	for current := cmd; current != nil; current = current.Parent() {
		collect(current.PersistentFlags())
	}
	collect(cmd.Flags())
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})
	return result
}

func markFlagTelemetrySafe(flag *pflag.Flag) {
	if flag == nil {
		return
	}
	if flag.Annotations == nil {
		flag.Annotations = map[string][]string{}
	}
	flag.Annotations[telemetrySafeValueAnnotation] = []string{"true"}
}

func telemetryFlagValue(flag *pflag.Flag) any {
	if flag == nil {
		return nil
	}
	if isTelemetrySafeFlag(flag) || isBooleanFlag(flag) || isEnumFlag(flag) {
		return actualTelemetryFlagValue(flag)
	}
	return redactedTelemetryValue
}

func isTelemetrySafeFlag(flag *pflag.Flag) bool {
	if flag == nil || flag.Annotations == nil {
		return false
	}
	values, ok := flag.Annotations[telemetrySafeValueAnnotation]
	return ok && len(values) > 0 && values[0] == "true"
}

func isBooleanFlag(flag *pflag.Flag) bool {
	return flag != nil && flag.Value.Type() == "bool"
}

func isEnumFlag(flag *pflag.Flag) bool {
	if flag == nil {
		return false
	}
	_, ok := flag.Value.(*utils.EnumFlag)
	return ok
}

func actualTelemetryFlagValue(flag *pflag.Flag) any {
	if isBooleanFlag(flag) {
		value, err := strconv.ParseBool(flag.Value.String())
		if err == nil {
			return value
		}
	}
	return flag.Value.String()
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
	return term.IsTerminal(int(os.Stdout.Fd())) //nolint:gosec // G115: stdout fd is a small int on supported platforms
}

func telemetryIsAgent() bool {
	return agent.IsAgent()
}

func telemetryEnvSignals() map[string]any {
	return envSignals(telemetryEnvPresenceVars, telemetryEnvValueVars)
}

func envSignals(presenceKeys []string, valueKeys []string) map[string]any {
	signals := make(map[string]any, len(presenceKeys)+len(valueKeys))
	for _, key := range presenceKeys {
		if hasTelemetryEnvValue(key) {
			signals[key] = true
		}
	}
	for _, key := range valueKeys {
		if value := telemetryEnvValue(key); value != "" {
			signals[key] = value
		}
	}
	if len(signals) == 0 {
		return nil
	}
	return signals
}

func hasTelemetryEnvValue(key string) bool {
	return strings.TrimSpace(os.Getenv(key)) != ""
}

func telemetryEnvValue(key string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return ""
	}
	if len(value) > maxTelemetryEnvValueLength {
		return value[:maxTelemetryEnvValueLength]
	}
	return value
}
