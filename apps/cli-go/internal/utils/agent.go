package utils

import "github.com/supabase/cli/internal/utils/agent"

// AgentMode is a global flag for overriding agent detection.
// Allowed values: "auto" (default), "yes", "no".
var AgentMode = EnumFlag{
	Allowed: []string{"auto", "yes", "no"},
	Value:   "auto",
}

// IsAgentMode returns true if the CLI is being used by an AI agent.
// "yes" forces agent mode on, "no" forces it off, and "auto" (default)
// auto-detects based on environment variables.
func IsAgentMode() bool {
	switch AgentMode.Value {
	case "yes":
		return true
	case "no":
		return false
	default:
		return agent.IsAgent()
	}
}
