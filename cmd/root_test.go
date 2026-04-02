package cmd

import (
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func clearAIToolEnv(t *testing.T) {
	for _, key := range []string{
		"AI_AGENT",
		"CURSOR_TRACE_ID",
		"CURSOR_EXTENSION_HOST_ROLE",
		"WINDSURF_SESSION_ID",
		"GEMINI_CLI",
		"CODEX_SANDBOX",
		"CODEX_CI",
		"CODEX_THREAD_ID",
		"ANTIGRAVITY_AGENT",
		"AUGMENT_AGENT",
		"OPENCODE_CLIENT",
		"CLAUDECODE",
		"CLAUDE_CODE",
		"COPILOT_MODEL",
		"COPILOT_ALLOW_ALL",
		"COPILOT_GITHUB_TOKEN",
		"REPL_ID",
	} {
		t.Setenv(key, "")
	}
}

func TestCommandAnalyticsContext(t *testing.T) {
	root := &cobra.Command{Use: "supabase"}
	var projectRef string
	var password string
	var debug bool
	output := utils.EnumFlag{
		Allowed: []string{"json", "table"},
		Value:   "table",
	}
	child := &cobra.Command{
		Use: "link",
		RunE: func(cmd *cobra.Command, args []string) error {
			return nil
		},
	}
	root.PersistentFlags().BoolVar(&debug, "debug", false, "")
	child.Flags().StringVar(&projectRef, "project-ref", "", "")
	child.Flags().StringVar(&password, "password", "", "")
	child.Flags().Var(&output, "output", "")
	child.Flags().AddFlag(root.PersistentFlags().Lookup("debug"))
	markFlagTelemetrySafe(child.Flags().Lookup("project-ref"))
	root.AddCommand(child)

	require.NoError(t, root.PersistentFlags().Set("debug", "true"))
	require.NoError(t, child.Flags().Set("project-ref", "proj_123"))
	require.NoError(t, child.Flags().Set("password", "hunter2"))
	require.NoError(t, child.Flags().Set("output", "json"))

	ctx := commandAnalyticsContext(child)

	assert.Equal(t, "link", ctx.Command)
	assert.Equal(t, map[string]any{
		"debug":       true,
		"output":      "json",
		"password":    redactedTelemetryValue,
		"project-ref": "proj_123",
	}, ctx.Flags)
	assert.NotContains(t, ctx.Flags, "linked")
	assert.NotEmpty(t, ctx.RunID)
}

func TestCommandName(t *testing.T) {
	root := &cobra.Command{Use: "supabase"}
	parent := &cobra.Command{Use: "db"}
	child := &cobra.Command{Use: "push"}
	root.AddCommand(parent)
	parent.AddCommand(child)

	assert.Equal(t, "db push", commandName(child))
	assert.Equal(t, "supabase", commandName(root))
}

func TestTelemetryAITool(t *testing.T) {
	t.Run("returns claude_code for spec env", func(t *testing.T) {
		clearAIToolEnv(t)
		t.Setenv("CLAUDE_CODE", "1")
		utils.AgentMode.Value = "auto"
		t.Cleanup(func() {
			utils.AgentMode.Value = "auto"
		})

		assert.Equal(t, "claude_code", telemetryAITool())
	})

	t.Run("returns cursor for session env", func(t *testing.T) {
		clearAIToolEnv(t)
		t.Setenv("CURSOR_EXTENSION_HOST_ROLE", "agent-exec")
		utils.AgentMode.Value = "auto"
		t.Cleanup(func() {
			utils.AgentMode.Value = "auto"
		})

		assert.Equal(t, "cursor", telemetryAITool())
	})
}
