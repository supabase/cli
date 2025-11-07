package mcpinit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

// vscodeClient implements the Client interface for VS Code
type vscodeClient struct {
	baseClient
}

func newVSCodeClient() *vscodeClient {
	return &vscodeClient{
		baseClient: baseClient{
			name:                "vscode",
			displayName:         "VS Code",
			installInstructions: "Download from https://code.visualstudio.com",
			checkInstalled: func() bool {
				return commandExists("code")
			},
		},
	}
}

func (c *vscodeClient) Configure(ctx context.Context, fsys afero.Fs) error {
	fmt.Println("Configuring VS Code...")
	fmt.Println()

	// Prompt for config scope using dropdown
	items := []utils.PromptItem{
		{
			Summary: "project",
			Details: "Project-local (in .vscode/mcp.json)",
		},
		{
			Summary: "global",
			Details: "Global (in your home directory)",
		},
	}

	choice, err := utils.PromptChoice(ctx, "Where would you like to add the configuration?", items, tea.WithOutput(os.Stderr))
	if err != nil {
		return err
	}

	var configPath string
	if choice.Summary == "global" {
		// Global config
		homeDir, _ := os.UserHomeDir()
		configPath = filepath.Join(homeDir, ".vscode", "mcp.json")
	} else {
		// Project-local config
		cwd, _ := os.Getwd()
		configPath = filepath.Join(cwd, ".vscode", "mcp.json")
	}

	// Prepare the Supabase MCP server config
	supabaseConfig := map[string]interface{}{
		"type": "http",
		"url":  "http://localhost:54321/mcp",
	}

	// Read existing config if it exists
	var config map[string]interface{}
	existingData, err := afero.ReadFile(fsys, configPath)
	if err == nil && len(existingData) > 0 {
		if err := json.Unmarshal(existingData, &config); err != nil {
			// If existing file is invalid JSON, start fresh
			config = make(map[string]interface{})
		}
	} else {
		config = make(map[string]interface{})
	}

	// Ensure servers exists
	servers, ok := config["servers"].(map[string]interface{})
	if !ok {
		servers = make(map[string]interface{})
		config["servers"] = servers
	}

	// Add or update Supabase server
	servers["supabase"] = supabaseConfig

	// Ensure directory exists
	configDir := filepath.Dir(configPath)
	if err := fsys.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// Write config
	configJSON, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := afero.WriteFile(fsys, configPath, configJSON, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	fmt.Println()
	fmt.Printf("✓ Successfully configured VS Code at: %s\n", configPath)
	fmt.Println()
	fmt.Println("Configuration added:")
	fmt.Println(`{
  "servers": {
    "supabase": {
      "type": "http",
      "url": "http://localhost:54321/mcp"
    }
  }
}`)
	fmt.Println()
	fmt.Println("The Supabase MCP server is now available in VS Code!")
	return nil
}
