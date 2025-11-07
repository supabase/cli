package mcpinit

import (
	"context"
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

// clientRegistry holds all supported clients
var clientRegistry = []Client{
	newClaudeCodeClient(),
	newCursorClient(),
	newVSCodeClient(),
}

// PromptMCPClient prompts the user to select an MCP client from the available options
func PromptMCPClient(ctx context.Context, opts ...tea.ProgramOption) (string, error) {
	// Add all clients plus "Other" option
	items := make([]utils.PromptItem, len(clientRegistry)+1)
	for i, client := range clientRegistry {
		items[i] = utils.PromptItem{
			Summary: client.Name(),
			Details: client.DisplayName(),
		}
	}
	// Add "Other" option at the end
	items[len(clientRegistry)] = utils.PromptItem{
		Summary: "other",
		Details: "Configure it manually",
	}

	choice, err := utils.PromptChoice(ctx, "Which client do you want to configure?", items, opts...)
	if err != nil {
		return "", err
	}

	return choice.Summary, nil
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
