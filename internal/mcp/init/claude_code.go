package mcpinit

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
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
	fmt.Println("Configuring Claude Code...")
	fmt.Println()

	// Use utils.PromptChoice for dropdown
	choice, err := utils.PromptChoice(ctx, "Where would you like to add the Claude Code MCP server?", []utils.PromptItem{
		{Summary: "local", Details: "Local (only for you in this project)"},
		{Summary: "project", Details: "Project (shared via .mcp.json in project root)"},
		{Summary: "user", Details: "User (available across all projects for your user)"},
	})
	if err != nil {
		fmt.Printf("⚠️  Warning: failed to select scope for Claude Code MCP server: %v\n", err)
		fmt.Println("Defaulting to local scope.")
		choice = utils.PromptItem{Summary: "local"}
	}

	cmdArgs := []string{"mcp", "add", "--transport", "http", "supabase", "http://localhost:54321/mcp"}
	if choice.Summary != "local" {
		cmdArgs = append(cmdArgs, "--scope", choice.Summary)
	}
	cmd := exec.CommandContext(ctx, "claude", cmdArgs...)

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	err = cmd.Run()
	if err != nil {
		fmt.Println()
		fmt.Printf("⚠️  Warning: failed to configure Claude Code MCP server: %v\n", err)
		fmt.Println("You may need to configure it manually.")
	} else {
		fmt.Println()
		fmt.Println("✓ Successfully added Supabase MCP server to Claude Code!")
		fmt.Println()
		// Command string display removed (cmdStr no longer exists)
		fmt.Println()
		fmt.Println("The server is now available in your Claude Code environment.")
	}
	return nil
}
