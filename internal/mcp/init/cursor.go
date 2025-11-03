package mcpinit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
)

// cursorClient implements the Client interface for Cursor
type cursorClient struct {
	baseClient
}

func newCursorClient() *cursorClient {
	return &cursorClient{
		baseClient: baseClient{
			name:                "cursor",
			displayName:         "Cursor",
			installInstructions: "Download from https://cursor.sh",
			checkInstalled: func() bool {
				return commandExists("cursor") || appExists("Cursor")
			},
		},
	}
}

func (c *cursorClient) Configure(ctx context.Context, fsys afero.Fs) error {
	fmt.Println("Configuring Cursor...")
	fmt.Println()

	// Prompt for config scope
	fmt.Println("Where would you like to add the configuration?")
	fmt.Println("  1. Project-local (in .cursor/mcp.json)")
	fmt.Println("  2. Global (in your home directory)")
	fmt.Print("Choice [1]: ")

	var choice string
	if _, err := fmt.Scanln(&choice); err != nil && err.Error() != "unexpected newline" {
		return fmt.Errorf("failed to read choice: %w", err)
	}
	if choice == "" {
		choice = "1"
	}

	var configPath string
	if choice == "2" {
		// Global config
		homeDir, _ := os.UserHomeDir()
		configPath = filepath.Join(homeDir, ".cursor", "mcp.json")
	} else {
		// Project-local config
		cwd, _ := os.Getwd()
		configPath = filepath.Join(cwd, ".cursor", "mcp.json")
	}

	// Prepare the Supabase MCP server config
	supabaseConfig := map[string]interface{}{
		"url": "https://mcp.supabase.com/mcp",
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

	// Ensure mcpServers exists
	mcpServers, ok := config["mcpServers"].(map[string]interface{})
	if !ok {
		mcpServers = make(map[string]interface{})
		config["mcpServers"] = mcpServers
	}

	// Add or update Supabase server
	mcpServers["supabase"] = supabaseConfig

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
	fmt.Printf("✓ Successfully configured Cursor at: %s\n", configPath)
	fmt.Println()
	fmt.Println("Configuration added:")
	fmt.Println(`{
  "mcpServers": {
    "supabase": {
      "url": "https://mcp.supabase.com/mcp"
    }
  }
}`)
	fmt.Println()
	fmt.Println("The Supabase MCP server is now available in Cursor!")
	return nil
}
