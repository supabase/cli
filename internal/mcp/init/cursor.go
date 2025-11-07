package mcpinit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
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

	choice, err := utils.PromptChoice(ctx, "Where would you like to add the configuration?", []utils.PromptItem{
		{Summary: "project", Details: "Project-local (in .cursor/mcp.json)"},
		{Summary: "global", Details: "Global (in your home directory)"},
	})
	if err != nil {
		return err
	}

	var configPath string
	if choice.Summary == "global" {
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

	// Generate example for display
	configExample, _ := json.MarshalIndent(map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"supabase": supabaseConfig,
		},
	}, "", "  ")

	fmt.Println()
	fmt.Printf("✓ Successfully configured Cursor at: %s\n", configPath)
	fmt.Println()
	fmt.Println("Configuration added:")
	fmt.Println(string(configExample))
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  1. Open Cursor")
	fmt.Println("  2. Navigate to Cursor Settings > Tools & MCP")
	fmt.Println("  3. Enable the 'supabase' MCP server")
	fmt.Println()
	fmt.Println("The Supabase MCP server will then be available in Cursor!")
	return nil
}
