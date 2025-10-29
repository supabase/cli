package mcpinit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/afero"
)

type ClientConfig struct {
	Name        string
	ConfigPath  string
	Description string
	Detected    bool
	Installed   bool
	CanAutomate bool
}

func Run(ctx context.Context, fsys afero.Fs, clientFlag string) error {
	clients := detectClients(fsys)

	var selectedClient *ClientConfig
	if clientFlag != "" {
		// Find the specified client
		for i := range clients {
			if strings.EqualFold(clients[i].Name, clientFlag) {
				selectedClient = &clients[i]
				break
			}
		}
		if selectedClient == nil {
			return fmt.Errorf("unknown client: %s. Supported clients: cursor, vscode, claude-desktop, claude-code, windsurf, cline, codex", clientFlag)
		}

		// Check if client is actually installed
		if !selectedClient.Installed {
			fmt.Printf("❌ %s is not installed on this system.\n\n", selectedClient.Name)
			displayConfigInstructions(*selectedClient)
			return nil
		}

		// Auto-configure if possible
		if selectedClient.CanAutomate {
			return configureClient(ctx, fsys, *selectedClient)
		}

		// Otherwise show manual instructions
		displayConfigInstructions(*selectedClient)
		return nil
	}

	// Interactive mode: show detected clients
	fmt.Println("Supabase MCP Server Configuration")
	fmt.Println("==================================")

	var installedClients []ClientConfig
	var notInstalledClients []ClientConfig

	for _, client := range clients {
		if client.Installed {
			installedClients = append(installedClients, client)
		} else {
			notInstalledClients = append(notInstalledClients, client)
		}
	}

	if len(installedClients) > 0 {
		fmt.Println("✓ Detected MCP Clients:")
		for _, client := range installedClients {
			fmt.Printf("  - %s: %s\n", client.Name, client.Description)
		}
		fmt.Println()
	}

	if len(notInstalledClients) > 0 {
		fmt.Println("ℹ Available but not installed:")
		for _, client := range notInstalledClients {
			fmt.Printf("  - %s: %s\n", client.Name, client.Description)
		}
		fmt.Println()
	}

	if len(installedClients) == 0 {
		fmt.Println("No MCP clients detected. Install one of the supported clients:")
		fmt.Println("  • Cursor: https://cursor.sh")
		fmt.Println("  • VS Code: https://code.visualstudio.com")
		fmt.Println("  • Claude Desktop: https://claude.ai/download")
		fmt.Println("  • Claude Code: Install via 'npm install -g @anthropic-ai/claude-cli'")
		fmt.Println("  • Windsurf: https://codeium.com/windsurf")
		fmt.Println("  • Cline: Install as VS Code extension")
		fmt.Println("  • Codex: https://codex.so")
		return nil
	}

	fmt.Println("Use the --client flag to configure a specific client.")
	fmt.Println("Example: supabase mcp init --client cursor")

	return nil
}

func detectClients(fsys afero.Fs) []ClientConfig {
	homeDir, _ := os.UserHomeDir()

	clients := []ClientConfig{
		{
			Name:        "cursor",
			ConfigPath:  filepath.Join(homeDir, ".cursor", "mcp.json"),
			Description: "Cursor AI Editor",
			CanAutomate: true,
		},
		{
			Name:        "vscode",
			ConfigPath:  filepath.Join(homeDir, ".vscode", "mcp.json"),
			Description: "Visual Studio Code with Copilot",
			CanAutomate: true,
		},
		{
			Name:        "claude-desktop",
			ConfigPath:  getClaudeDesktopConfigPath(),
			Description: "Claude Desktop App",
			CanAutomate: false,
		},
		{
			Name:        "claude-code",
			ConfigPath:  filepath.Join(homeDir, ".mcp.json"),
			Description: "Claude Code CLI",
			CanAutomate: true,
		},
		{
			Name:        "windsurf",
			ConfigPath:  getWindsurfConfigPath(),
			Description: "Windsurf Editor by Codeium",
			CanAutomate: false,
		},
		{
			Name:        "cline",
			ConfigPath:  filepath.Join(homeDir, ".vscode", "mcp.json"),
			Description: "Cline VS Code Extension",
			CanAutomate: false,
		},
		{
			Name:        "codex",
			ConfigPath:  getCodexConfigPath(),
			Description: "Codex AI Editor",
			CanAutomate: false,
		},
	}

	// Check for directory existence (config folder)
	for i := range clients {
		configDir := filepath.Dir(clients[i].ConfigPath)
		if _, err := fsys.Stat(configDir); err == nil {
			clients[i].Detected = true
		}

		// Check if client is actually installed
		clients[i].Installed = isClientInstalled(clients[i].Name)
	}

	return clients
}

func isClientInstalled(clientName string) bool {
	switch clientName {
	case "cursor":
		// Check for cursor binary
		return commandExists("cursor") || appExists("Cursor")
	case "vscode":
		// Check for code binary
		return commandExists("code")
	case "claude-desktop":
		// Check for Claude app
		return appExists("Claude")
	case "claude-code":
		// Check for claude CLI
		return commandExists("claude")
	case "windsurf":
		// Check for windsurf binary or app
		return commandExists("windsurf") || appExists("Windsurf")
	case "cline":
		// Cline is a VS Code extension, check if VS Code is installed
		return commandExists("code")
	case "codex":
		// Check for codex binary or app
		return commandExists("codex") || appExists("Codex")
	default:
		return false
	}
}

func commandExists(command string) bool {
	_, err := exec.LookPath(command)
	return err == nil
}

func appExists(appName string) bool {
	if runtime.GOOS == "darwin" {
		// Check in common macOS app locations
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

func getClaudeDesktopConfigPath() string {
	homeDir, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json")
	case "windows":
		return filepath.Join(homeDir, "AppData", "Roaming", "Claude", "config.json")
	default:
		return filepath.Join(homeDir, ".config", "Claude", "config.json")
	}
}

func getWindsurfConfigPath() string {
	homeDir, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(homeDir, "Library", "Application Support", "Windsurf", "User", "globalStorage", "windsurf.mcp", "config.json")
	case "windows":
		return filepath.Join(homeDir, "AppData", "Roaming", "Windsurf", "User", "globalStorage", "windsurf.mcp", "config.json")
	default:
		return filepath.Join(homeDir, ".config", "Windsurf", "User", "globalStorage", "windsurf.mcp", "config.json")
	}
}

func getCodexConfigPath() string {
	homeDir, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(homeDir, "Library", "Application Support", "Codex", "mcp.json")
	case "windows":
		return filepath.Join(homeDir, "AppData", "Roaming", "Codex", "mcp.json")
	default:
		return filepath.Join(homeDir, ".config", "Codex", "mcp.json")
	}
}

func configureClient(ctx context.Context, fsys afero.Fs, client ClientConfig) error {
	if client.Name == "claude-code" {
		return configureClaudeCode(ctx)
	}

	// JSON-based clients (Cursor, VS Code)
	return configureJSONClient(fsys, client)
}

func configureClaudeCode(ctx context.Context) error {
	fmt.Printf("Configuring Claude Code...\n\n")

	// Prompt for scope
	fmt.Println("Would you like to add this server:")
	fmt.Println("  1. Globally (available in all projects)")
	fmt.Println("  2. Locally (only in current project)")
	fmt.Print("Choice [1]: ")

	var scope string
	if _, err := fmt.Scanln(&scope); err != nil && err.Error() != "unexpected newline" {
		return fmt.Errorf("failed to read scope choice: %w", err)
	}
	if scope == "" {
		scope = "1"
	}

	scopeFlag := "global"
	if scope == "2" {
		scopeFlag = "local"
	}

	// Prompt for access token
	fmt.Print("\nEnter your Supabase access token: ")
	var accessToken string
	if _, err := fmt.Scanln(&accessToken); err != nil {
		return fmt.Errorf("failed to read access token: %w", err)
	}

	if accessToken == "" {
		return fmt.Errorf("access token is required")
	}

	// Build the claude mcp add command for remote server
	// #nosec G204 -- user input is validated and used in controlled context
	cmd := exec.CommandContext(ctx, "claude", "mcp", "add", "supabase",
		"-s", scopeFlag,
		"-e", fmt.Sprintf("SUPABASE_MCP_SERVER_PERSONAL_ACCESS_TOKEN=%s", accessToken),
		"--",
		"remote",
		"https://mcp.supabase.com/mcp",
	)

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to configure Claude Code: %w", err)
	}

	fmt.Println("\n✓ Successfully configured Claude Code with Supabase MCP Server (remote)")
	return nil
}

func configureJSONClient(fsys afero.Fs, client ClientConfig) error {
	fmt.Printf("Configuring %s...\n\n", client.Name)

	// Prompt for access token
	fmt.Print("Enter your Supabase access token: ")
	var accessToken string
	if _, err := fmt.Scanln(&accessToken); err != nil {
		return fmt.Errorf("failed to read access token: %w", err)
	}

	if accessToken == "" {
		return fmt.Errorf("access token is required")
	}

	// Prompt for scope
	fmt.Println("\nWould you like to configure:")
	fmt.Println("  1. Project-local config (in .vscode/mcp.json or .cursor/mcp.json)")
	fmt.Println("  2. Global config (in your home directory)")
	fmt.Print("Choice [1]: ")

	var choice string
	if _, err := fmt.Scanln(&choice); err != nil && err.Error() != "unexpected newline" {
		return fmt.Errorf("failed to read config scope choice: %w", err)
	}
	if choice == "" {
		choice = "1"
	}

	var configPath string
	if choice == "2" {
		// Global config
		configPath = client.ConfigPath
	} else {
		// Project-local config
		cwd, _ := os.Getwd()
		if client.Name == "vscode" || client.Name == "cline" {
			configPath = filepath.Join(cwd, ".vscode", "mcp.json")
		} else {
			configPath = filepath.Join(cwd, ".cursor", "mcp.json")
		}
	}

	// Get the remote server config
	var config map[string]interface{}
	if client.Name == "vscode" {
		config = getRemoteVSCodeConfig(accessToken)
	} else {
		config = getRemoteCursorStyleConfig(accessToken)
	}

	// Ensure directory exists
	configDir := filepath.Dir(configPath)
	if err := fsys.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// Read existing config if it exists
	existingData, err := afero.ReadFile(fsys, configPath)
	if err == nil {
		var existing map[string]interface{}
		if err := json.Unmarshal(existingData, &existing); err == nil {
			// Merge configs
			for key, value := range config {
				if key == "mcpServers" || key == "servers" {
					// Merge server configs
					if existingServers, ok := existing[key].(map[string]interface{}); ok {
						if newServers, ok := value.(map[string]interface{}); ok {
							for serverName, serverConfig := range newServers {
								existingServers[serverName] = serverConfig
							}
							config[key] = existingServers
						}
					}
				} else {
					existing[key] = value
				}
			}
			config = existing
		}
	}

	// Write config
	configJSON, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := afero.WriteFile(fsys, configPath, configJSON, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	fmt.Printf("\n✓ Successfully configured %s at: %s\n", client.Name, configPath)
	fmt.Println("\nThe remote Supabase MCP Server is now connected via OAuth.")
	fmt.Println("Your access token will be used to authenticate with Supabase.")

	return nil
}

func getRemoteCursorStyleConfig(accessToken string) map[string]interface{} {
	return map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"supabase": map[string]interface{}{
				"type": "remote",
				"url":  "https://mcp.supabase.com/mcp",
				"oauth": map[string]interface{}{
					"authorizationServer": "https://api.supabase.com",
					"clientId":            "mcp-server",
					"scopes":              []string{"mcp"},
				},
				"env": map[string]string{
					"SUPABASE_MCP_SERVER_PERSONAL_ACCESS_TOKEN": accessToken,
				},
			},
		},
	}
}

func getRemoteVSCodeConfig(accessToken string) map[string]interface{} {
	return map[string]interface{}{
		"servers": map[string]interface{}{
			"supabase": map[string]interface{}{
				"type": "remote",
				"url":  "https://mcp.supabase.com/mcp",
				"oauth": map[string]interface{}{
					"authorizationServer": "https://api.supabase.com",
					"clientId":            "mcp-server",
					"scopes":              []string{"mcp"},
				},
				"env": map[string]string{
					"SUPABASE_MCP_SERVER_PERSONAL_ACCESS_TOKEN": accessToken,
				},
			},
		},
	}
}

func displayConfigInstructions(client ClientConfig) {
	fmt.Printf("Manual Configuration Instructions for %s\n", client.Name)
	fmt.Println(strings.Repeat("=", 50))
	fmt.Println()

	accessTokenPlaceholder := "<your-access-token>"

	switch client.Name {
	case "cursor":
		fmt.Println("1. Open Cursor Settings")
		fmt.Println("2. Navigate to MCP Servers configuration")
		fmt.Printf("3. Add the following to %s:\n", client.ConfigPath)
		fmt.Println()
		fmt.Printf(`{
  "mcpServers": {
    "supabase": {
      "type": "remote",
      "url": "https://mcp.supabase.com/mcp",
      "oauth": {
        "authorizationServer": "https://api.supabase.com",
        "clientId": "mcp-server",
        "scopes": ["mcp"]
      },
      "env": {
        "SUPABASE_MCP_SERVER_PERSONAL_ACCESS_TOKEN": "%s"
      }
    }
  }
}
`, accessTokenPlaceholder)

	case "vscode", "cline":
		fmt.Println("1. Open VS Code")
		fmt.Println("2. Create .vscode/mcp.json in your project root")
		fmt.Println("3. Add the following configuration:")
		fmt.Println()
		fmt.Printf(`{
  "servers": {
    "supabase": {
      "type": "remote",
      "url": "https://mcp.supabase.com/mcp",
      "oauth": {
        "authorizationServer": "https://api.supabase.com",
        "clientId": "mcp-server",
        "scopes": ["mcp"]
      },
      "env": {
        "SUPABASE_MCP_SERVER_PERSONAL_ACCESS_TOKEN": "%s"
      }
    }
  }
}
`, accessTokenPlaceholder)

	case "claude-desktop":
		fmt.Println("1. Open Claude Desktop")
		fmt.Println("2. Go to Settings > Developer > Edit Config")
		fmt.Printf("3. Add the following to %s:\n", client.ConfigPath)
		fmt.Println()
		fmt.Printf(`{
  "mcpServers": {
    "supabase": {
      "type": "remote",
      "url": "https://mcp.supabase.com/mcp",
      "oauth": {
        "authorizationServer": "https://api.supabase.com",
        "clientId": "mcp-server",
        "scopes": ["mcp"]
      },
      "env": {
        "SUPABASE_MCP_SERVER_PERSONAL_ACCESS_TOKEN": "%s"
      }
    }
  }
}
`, accessTokenPlaceholder)
		fmt.Println("\n4. Restart Claude Desktop")

	case "claude-code":
		fmt.Println("Run this command:")
		fmt.Printf("  claude mcp add supabase -s global -e SUPABASE_MCP_SERVER_PERSONAL_ACCESS_TOKEN=%s -- remote https://mcp.supabase.com/mcp\n", accessTokenPlaceholder)

	case "windsurf":
		fmt.Println("1. Open Windsurf")
		fmt.Println("2. Navigate to Cascade > MCP > Configure")
		fmt.Printf("3. Add the following to %s:\n", client.ConfigPath)
		fmt.Println()
		fmt.Printf(`{
  "mcpServers": {
    "supabase": {
      "type": "remote",
      "url": "https://mcp.supabase.com/mcp",
      "oauth": {
        "authorizationServer": "https://api.supabase.com",
        "clientId": "mcp-server",
        "scopes": ["mcp"]
      },
      "env": {
        "SUPABASE_MCP_SERVER_PERSONAL_ACCESS_TOKEN": "%s"
      }
    }
  }
}
`, accessTokenPlaceholder)
		fmt.Println("\n4. Tap 'Refresh' in Cascade assistant")

	case "codex":
		fmt.Println("1. Open Codex")
		fmt.Println("2. Navigate to Settings > MCP Servers")
		fmt.Printf("3. Add the following to %s:\n", client.ConfigPath)
		fmt.Println()
		fmt.Printf(`{
  "mcpServers": {
    "supabase": {
      "type": "remote",
      "url": "https://mcp.supabase.com/mcp",
      "oauth": {
        "authorizationServer": "https://api.supabase.com",
        "clientId": "mcp-server",
        "scopes": ["mcp"]
      },
      "env": {
        "SUPABASE_MCP_SERVER_PERSONAL_ACCESS_TOKEN": "%s"
      }
    }
  }
}
`, accessTokenPlaceholder)
		fmt.Println("\n4. Restart Codex")
	}

	fmt.Println("\n" + strings.Repeat("=", 50))
	fmt.Println("\nTo get your access token:")
	fmt.Println("  1. Go to https://supabase.com/dashboard/account/tokens")
	fmt.Println("  2. Create a new access token")
	fmt.Println("  3. Copy and use it in the configuration above")
	fmt.Println("\nFor more information, visit:")
	fmt.Println("  https://supabase.com/docs/guides/getting-started/mcp")
}
