package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// clearAgentEnv unsets all known agent environment variables for a clean test.
func clearAgentEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"AI_AGENT",
		"CURSOR_EXTENSION_HOST_ROLE",
		"GEMINI_CLI",
		"CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID",
		"ANTIGRAVITY_AGENT",
		"AUGMENT_AGENT",
		"OPENCODE_CLIENT",
		"CLAUDECODE", "CLAUDE_CODE",
		"REPL_ID",
		"COPILOT_MODEL", "COPILOT_ALLOW_ALL", "COPILOT_GITHUB_TOKEN",
	} {
		t.Setenv(key, "")
	}
}

func TestIsAgent(t *testing.T) {
	t.Run("returns false with no agent env vars", func(t *testing.T) {
		clearAgentEnv(t)
		assert.False(t, IsAgent())
	})

	t.Run("detects AI_AGENT", func(t *testing.T) {
		clearAgentEnv(t)
		t.Setenv("AI_AGENT", "custom-agent")
		assert.True(t, IsAgent())
	})

	t.Run("ignores empty AI_AGENT", func(t *testing.T) {
		clearAgentEnv(t)
		t.Setenv("AI_AGENT", "  ")
		assert.False(t, IsAgent())
	})

	t.Run("detects Cursor via CURSOR_TRACE_ID", func(t *testing.T) {
		t.Setenv("CURSOR_EXTENSION_HOST_ROLE", "agent-exec")
		assert.True(t, IsAgent())
	})

	t.Run("detects Gemini via GEMINI_CLI", func(t *testing.T) {
		t.Setenv("GEMINI_CLI", "1")
		assert.True(t, IsAgent())
	})

	t.Run("detects Codex via CODEX_SANDBOX", func(t *testing.T) {
		t.Setenv("CODEX_SANDBOX", "1")
		assert.True(t, IsAgent())
	})

	t.Run("detects Claude Code via CLAUDECODE", func(t *testing.T) {
		t.Setenv("CLAUDECODE", "1")
		assert.True(t, IsAgent())
	})

	t.Run("detects Claude Code via CLAUDE_CODE", func(t *testing.T) {
		t.Setenv("CLAUDE_CODE", "1")
		assert.True(t, IsAgent())
	})

	t.Run("detects GitHub Copilot via COPILOT_MODEL", func(t *testing.T) {
		t.Setenv("COPILOT_MODEL", "gpt-4")
		assert.True(t, IsAgent())
	})

	t.Run("detects Replit via REPL_ID", func(t *testing.T) {
		t.Setenv("REPL_ID", "abc")
		assert.True(t, IsAgent())
	})

	t.Run("detects Augment via AUGMENT_AGENT", func(t *testing.T) {
		t.Setenv("AUGMENT_AGENT", "1")
		assert.True(t, IsAgent())
	})

	t.Run("detects OpenCode via OPENCODE_CLIENT", func(t *testing.T) {
		t.Setenv("OPENCODE_CLIENT", "1")
		assert.True(t, IsAgent())
	})

	t.Run("detects Antigravity via ANTIGRAVITY_AGENT", func(t *testing.T) {
		t.Setenv("ANTIGRAVITY_AGENT", "1")
		assert.True(t, IsAgent())
	})
}

func TestGetAgentName(t *testing.T) {
	t.Run("returns claude_code for CLAUDE_CODE", func(t *testing.T) {
		t.Setenv("CLAUDE_CODE", "1")
		assert.Equal(t, "claude_code", GetAgentName())
	})
	t.Run("returns cursor for CURSOR_EXTENSION_HOST_ROLE", func(t *testing.T) {
		t.Setenv("CURSOR_EXTENSION_HOST_ROLE", "agent-exec")
		assert.Equal(t, "cursor", GetAgentName())
	})
}
