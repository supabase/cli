package mcpinit

import (
	"context"
	"fmt"
	"os"
	"os/exec"

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

// clientRegistry holds all supported clients
var clientRegistry = []Client{
	&claudeCodeClient{},
	// Add new clients here in the future:
	// &cursorClient{},
	// &vscodeClient{},
	// &claudeDesktopClient{},
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
type claudeCodeClient struct{}

func (c *claudeCodeClient) Name() string {
	return "claude-code"
}

func (c *claudeCodeClient) DisplayName() string {
	return "Claude Code"
}

func (c *claudeCodeClient) IsInstalled() bool {
	return commandExists("claude")
}

func (c *claudeCodeClient) InstallInstructions() string {
	return "npm install -g @anthropic-ai/claude-cli"
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

// Example template for adding a new client:
//
// type newClientName struct{}
//
// func (c *newClientName) Name() string {
//     return "client-name"  // CLI identifier
// }
//
// func (c *newClientName) DisplayName() string {
//     return "Client Name"  // Human-readable name
// }
//
// func (c *newClientName) IsInstalled() bool {
//     // Check if client is installed
//     return commandExists("client-command") || appExists("ClientApp")
// }
//
// func (c *newClientName) InstallInstructions() string {
//     return "Installation instructions here"
// }
//
// func (c *newClientName) Configure(ctx context.Context, fsys afero.Fs) error {
//     fmt.Println("Configuring Client Name...")
//     fmt.Println()
//     
//     // Implementation specific to this client
//     // Could be:
//     // - Running a CLI command
//     // - Writing a JSON config file
//     // - Manual instructions display
//     
//     return nil
// }
//
// Then add to clientRegistry:
// var clientRegistry = []Client{
//     &claudeCodeClient{},
//     &newClientName{},  // Add here
// }


