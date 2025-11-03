package mcpinit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/spf13/afero"
)

// Client represents an MCP client that can be configured
type Client interface {
	// Name returns the client identifier (e.g., "claude-code")
	Name() string
	
	// DisplayName returns the human-readable name (e.g., "Claude Code")
	DisplayName() string
	
	// IsInstalled checks if the client is installed on the system
	IsInstalled() bool
	
	// InstallInstructions returns instructions for installing the client
	InstallInstructions() string
	
	// Configure performs the configuration for this client
	Configure(ctx context.Context, fsys afero.Fs) error
}


// baseClient provides default implementations for the Client interface
type baseClient struct {
	name                string
	displayName         string
	installInstructions string
	checkInstalled      func() bool
}

func (b *baseClient) Name() string {
	return b.name
}

func (b *baseClient) DisplayName() string {
	return b.displayName
}

func (b *baseClient) IsInstalled() bool {
	if b.checkInstalled != nil {
		return b.checkInstalled()
	}
	return false
}

func (b *baseClient) InstallInstructions() string {
	return b.installInstructions
}

// clientRegistry holds all supported clients
var clientRegistry = []Client{
	newClaudeCodeClient(),
	newCursorClient(),
	// Add new clients here in the future:
	// newVSCodeClient(),
	// newClaudeDesktopClient(),
}

func Run(ctx context.Context, fsys afero.Fs, clientFlag string) error {
	// If a specific client is requested
	if clientFlag != "" {
		return configureSpecificClient(ctx, fsys, clientFlag)
	}

	// Find installed clients
	var installedClients []Client
	for _, client := range clientRegistry {
		if client.IsInstalled() {
			installedClients = append(installedClients, client)
		}
	}

	// If no clients installed, show available options
	if len(installedClients) == 0 {
		fmt.Println("No MCP clients detected on this system.")
		fmt.Println()
		fmt.Println("Available clients:")
		for _, client := range clientRegistry {
			fmt.Printf("  • %s\n", client.DisplayName())
			fmt.Printf("    Install: %s\n", client.InstallInstructions())
			fmt.Println()
		}
		fmt.Println("After installing a client, run this command again.")
		return nil
	}

	// If only one client is installed, configure it directly
	if len(installedClients) == 1 {
		client := installedClients[0]
		fmt.Printf("Detected %s\n", client.DisplayName())
		fmt.Println()
		return client.Configure(ctx, fsys)
	}

	// Multiple clients installed - show options
	fmt.Println("Multiple MCP clients detected:")
	for i, client := range installedClients {
		fmt.Printf("  %d. %s\n", i+1, client.DisplayName())
	}
	fmt.Println()
	fmt.Println("Use the --client flag to configure a specific client:")
	for _, client := range installedClients {
		fmt.Printf("  supabase mcp init --client %s\n", client.Name())
	}
	
	return nil
}

func configureSpecificClient(ctx context.Context, fsys afero.Fs, clientName string) error {
	// Find the requested client
	var targetClient Client
	for _, client := range clientRegistry {
		if client.Name() == clientName {
			targetClient = client
			break
		}
	}

	if targetClient == nil {
		fmt.Printf("❌ Unknown client: %s\n\n", clientName)
		fmt.Println("Supported clients:")
		for _, client := range clientRegistry {
			fmt.Printf("  • %s\n", client.Name())
		}
		return fmt.Errorf("unknown client: %s", clientName)
	}

	// Check if installed
	if !targetClient.IsInstalled() {
		fmt.Printf("❌ %s is not installed on this system.\n\n", targetClient.DisplayName())
		fmt.Println("To install:")
		fmt.Printf("  %s\n", targetClient.InstallInstructions())
		return nil
	}

	// Configure
	fmt.Printf("Configuring %s...\n\n", targetClient.DisplayName())
	return targetClient.Configure(ctx, fsys)
}

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

// Helper function to check if a command exists
func commandExists(command string) bool {
	_, err := exec.LookPath(command)
	return err == nil
}

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

// appExists checks if a macOS application is installed
func appExists(appName string) bool {
	if runtime.GOOS == "darwin" {
		locations := []string{
			fmt.Sprintf("/Applications/%s.app", appName),
			fmt.Sprintf("%s/Applications/%s.app", os.Getenv("HOME"), appName),
		}
		for _, location := range locations {
			if _, err := os.Stat(location); err == nil {
				return true
			}
		}
	}
	return false
}

// Example: Adding a new client
//
// 1. Create a struct that embeds baseClient:
//
//    type myNewClient struct {
//        baseClient
//    }
//
// 2. Create a constructor function:
//
//    func newMyNewClient() *myNewClient {
//        return &myNewClient{
//            baseClient: baseClient{
//                name:                "my-client",
//                displayName:         "My Client",
//                installInstructions: "Installation command or URL",
//                checkInstalled: func() bool {
//                    return commandExists("my-cli") || appExists("MyApp")
//                },
//            },
//        }
//    }
//
// 3. Implement the Configure method:
//
//    func (c *myNewClient) Configure(ctx context.Context, fsys afero.Fs) error {
//        // Your configuration logic here
//        // See claudeCodeClient or cursorClient for examples
//        return nil
//    }
//
// 4. Add to clientRegistry:
//
//    var clientRegistry = []Client{
//        newClaudeCodeClient(),
//        newCursorClient(),
//        newMyNewClient(),  // Add here
//    }


