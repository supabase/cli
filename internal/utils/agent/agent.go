package agent

import (
	"os"
	"strings"
)

// IsAgent checks environment variables to detect if the CLI is being invoked
// by an AI coding agent. Based on the detection logic from Vercel's
// @vercel/functions/ai package.
func IsAgent() bool {
	if v := strings.TrimSpace(os.Getenv("AI_AGENT")); v != "" {
		return true
	}
	// Cursor
	if os.Getenv("CURSOR_EXTENSION_HOST_ROLE") != "" {
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
	if os.Getenv("CLAUDECODE") != "" || os.Getenv("CLAUDE_CODE") != "" {
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

func GetAgentName() string {
	if IsAgent() {
		switch {
		case os.Getenv("CLAUDE_CODE") != "" || os.Getenv("CLAUDECODE") != "":
			return "claude_code"
		case os.Getenv("CURSOR_EXTENSION_HOST_ROLE") != "":
			return "cursor"
		case os.Getenv("GEMINI_CLI") != "":
			return "gemini"
		case os.Getenv("CODEX_SANDBOX") != "" || os.Getenv("CODEX_CI") != "" || os.Getenv("CODEX_THREAD_ID") != "":
			return "codex"
		case os.Getenv("ANTIGRAVITY_AGENT") != "":
			return "antigravity"
		case os.Getenv("AUGMENT_AGENT") != "":
			return "augment"
		case os.Getenv("OPENCODE_CLIENT") != "":
			return "opencode"
		case os.Getenv("COPILOT_MODEL") != "" || os.Getenv("COPILOT_ALLOW_ALL") != "" || os.Getenv("COPILOT_GITHUB_TOKEN") != "":
			return "copilot"
		case os.Getenv("REPL_ID") != "":
			return "replit"
		default:
			return "ai_agent"
		}
	}
	return ""
}
