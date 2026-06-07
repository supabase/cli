package agent

import (
	"os"
	"strings"
)

// IsClaudeCode reports whether the CLI is running inside Claude Code.
func IsClaudeCode() bool {
	return os.Getenv("CLAUDECODE") != "" || os.Getenv("CLAUDE_CODE") != ""
}

// IsAgent checks environment variables to detect if the CLI is being invoked
// by an AI coding agent. Based on the detection logic from Vercel's
// @vercel/functions/ai package.
func IsAgent() bool {
	if v := strings.TrimSpace(os.Getenv("AI_AGENT")); v != "" {
		return true
	}
	// Cursor
	if os.Getenv("CURSOR_AGENT") != "" || os.Getenv("CURSOR_EXTENSION_HOST_ROLE") != "" {
		return true
	}
	// Gemini
	if os.Getenv("GEMINI_CLI") != "" {
		return true
	}
	// Codex
	if os.Getenv("CODEX_SANDBOX") != "" || os.Getenv("CODEX_CI") != "" || os.Getenv("CODEX_THREAD_ID") != "" {
		return true
	}
	// Antigravity
	if os.Getenv("ANTIGRAVITY_AGENT") != "" {
		return true
	}
	// Augment
	if os.Getenv("AUGMENT_AGENT") != "" {
		return true
	}
	// OpenCode
	if os.Getenv("OPENCODE_CLIENT") != "" {
		return true
	}
	// Claude Code
	if IsClaudeCode() {
		return true
	}
	// Replit
	if os.Getenv("REPL_ID") != "" {
		return true
	}
	// GitHub Copilot
	if os.Getenv("COPILOT_MODEL") != "" || os.Getenv("COPILOT_ALLOW_ALL") != "" || os.Getenv("COPILOT_GITHUB_TOKEN") != "" {
		return true
	}
	// Devin
	if _, err := os.Stat("/opt/.devin"); err == nil {
		return true
	}
	return false
}
