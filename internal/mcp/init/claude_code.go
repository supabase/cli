package mcpinit

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/afero"
)

// claudeCodeClient implements the Client interface for Claude Code
type claudeCodeClient struct {
	baseClient
}

func newClaudeCodeClient() *claudeCodeClient {
	return &claudeCodeClient{
		baseClient: baseClient{
			name:                "claude-code",
			displayName:         "Claude Code",
			installInstructions: "npm install -g @anthropic-ai/claude-cli",
			checkInstalled: func() bool {
				return commandExists("claude")
			},
		},
	}
}

func (c *claudeCodeClient) Configure(ctx context.Context, fsys afero.Fs) error {
	fmt.Println("Adding Supabase MCP server to Claude Code...")
	fmt.Println()

	// Build the claude mcp add command
	// #nosec G204 -- command and URL are controlled constants
	cmd := exec.CommandContext(ctx, "claude", "mcp", "add", "--transport", "http", "supabase", "https://mcp.supabase.com/mcp")

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to configure Claude Code: %w", err)
	}

	fmt.Println()
	fmt.Println("✓ Successfully added Supabase MCP server to Claude Code!")
	fmt.Println()
	fmt.Println("The server is now available in your Claude Code environment.")
	return nil
}
