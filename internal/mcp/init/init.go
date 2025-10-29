package mcpinit

import (
"context"
"encoding/json"
"fmt"
"os"
"path/filepath"
"runtime"
"strings"

"github.com/spf13/afero"
)

type ClientConfig struct {
	Name        string
	ConfigPath  string
	ConfigType  string // "cursor", "vscode", "claude-desktop", "claude-code", "windsurf", "cline"
	Detected    bool
}

// Run executes the MCP initialization wizard
func Run(ctx context.Context, fsys afero.Fs, targetClient string) error {
	fmt.Println("🚀 Supabase MCP Server Setup")
	fmt.Println("───────────────────────────────")
	fmt.Println()

	// Detect or validate client
	clients := detectClients()
	
	if targetClient != "" {
		// Validate the specified client
		found := false
		for _, c := range clients {
			if strings.EqualFold(c.ConfigType, targetClient) {
				found = true
				fmt.Printf("📍 Configuring for: %s\n", c.Name)
				fmt.Printf("   Config path: %s\n\n", c.ConfigPath)
				displayConfigInstructions(c.ConfigType)
				break
			}
		}
		if !found {
			return fmt.Errorf("unknown client: %s. Supported clients: cursor, vscode, claude-desktop, claude-code, windsurf, cline", targetClient)
		}
	} else {
		// Display detected clients
		fmt.Println("🔍 Detected MCP-compatible clients:")
		fmt.Println()
		
		detectedCount := 0
		for _, c := range clients {
			if c.Detected {
				fmt.Printf("  ✅ %s\n", c.Name)
				fmt.Printf("     Config: %s\n", c.ConfigPath)
				detectedCount++
			}
		}
		
		if detectedCount == 0 {
			fmt.Println("  ⚠️  No MCP clients detected on this system")
			fmt.Println()
			fmt.Println("Supported clients:")
			for _, c := range clients {
				fmt.Printf("  • %s (%s)\n", c.Name, c.ConfigPath)
			}
		}
		
		fmt.Println()
		fmt.Println("💡 To configure a specific client, use:")
		fmt.Println("   supabase mcp init --client <client-name>")
		fmt.Println()
		fmt.Println("   Supported clients:")
		fmt.Println("   • cursor")
		fmt.Println("   • vscode")
		fmt.Println("   • claude-desktop")
		fmt.Println("   • claude-code")
		fmt.Println("   • windsurf")
		fmt.Println("   • cline")
	}

	return nil
}

// detectClients checks for installed MCP clients
func detectClients() []ClientConfig {
	homeDir, _ := os.UserHomeDir()
	
	clients := []ClientConfig{
		{
			Name:       "Cursor",
			ConfigPath: filepath.Join(homeDir, ".cursor", "mcp.json"),
			ConfigType: "cursor",
		},
		{
			Name:       "VS Code (Copilot)",
			ConfigPath: filepath.Join(homeDir, ".vscode", "mcp.json"),
			ConfigType: "vscode",
		},
		{
			Name:       "Claude Desktop",
			ConfigPath: getClaudeDesktopConfigPath(homeDir),
			ConfigType: "claude-desktop",
		},
		{
			Name:       "Claude Code",
			ConfigPath: filepath.Join(homeDir, ".mcp.json"),
			ConfigType: "claude-code",
		},
		{
			Name:       "Windsurf",
			ConfigPath: getWindsurfConfigPath(homeDir),
			ConfigType: "windsurf",
		},
		{
			Name:       "Cline (VS Code)",
			ConfigPath: getClineConfigPath(homeDir),
			ConfigType: "cline",
		},
	}

	// Check which clients are actually installed
	for i := range clients {
		if _, err := os.Stat(filepath.Dir(clients[i].ConfigPath)); err == nil {
			clients[i].Detected = true
		}
	}

	return clients
}

func getClaudeDesktopConfigPath(homeDir string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json")
	case "windows":
		return filepath.Join(homeDir, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
	default: // linux
		return filepath.Join(homeDir, ".config", "Claude", "claude_desktop_config.json")
	}
}

func getWindsurfConfigPath(homeDir string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(homeDir, "Library", "Application Support", "Windsurf", "User", "globalStorage", "windsurf-cascade", "mcp_settings.json")
	case "windows":
		return filepath.Join(homeDir, "AppData", "Roaming", "Windsurf", "User", "globalStorage", "windsurf-cascade", "mcp_settings.json")
	default: // linux
		return filepath.Join(homeDir, ".config", "Windsurf", "User", "globalStorage", "windsurf-cascade", "mcp_settings.json")
	}
}

func getClineConfigPath(homeDir string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(homeDir, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
	case "windows":
		return filepath.Join(homeDir, "AppData", "Roaming", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
	default: // linux
		return filepath.Join(homeDir, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
	}
}

// displayConfigInstructions shows the configuration template for a specific client
func displayConfigInstructions(clientType string) {
	fmt.Println("📝 Configuration Template:")
	fmt.Println()
	
	var config interface{}
	var configStr string
	
	switch clientType {
	case "cursor", "windsurf", "cline":
		config = getCursorStyleConfig()
	case "vscode":
		config = getVSCodeConfig()
	case "claude-desktop":
		config = getCursorStyleConfig() // Same format as Cursor
	case "claude-code":
		config = getClaudeCodeConfig()
	}
	
	configJSON, _ := json.MarshalIndent(config, "", "  ")
	configStr = string(configJSON)
	
	// Add platform-specific commands
	fmt.Println(configStr)
	fmt.Println()
	
	fmt.Println("📋 Setup Instructions:")
	fmt.Println()
	
	switch clientType {
	case "cursor":
		fmt.Println("1. Create .cursor/mcp.json in your project root")
		fmt.Println("2. Replace <project-ref> with your Supabase project reference")
		fmt.Println("3. Replace <personal-access-token> with your PAT from:")
		fmt.Println("   https://supabase.com/dashboard/account/tokens")
		fmt.Println("4. Open Cursor → Settings → MCP to verify connection")
		
	case "vscode":
		fmt.Println("1. Create .vscode/mcp.json in your project root")
		fmt.Println("2. Replace <project-ref> with your Supabase project reference")
		fmt.Println("3. Open Copilot chat and switch to Agent mode")
		fmt.Println("4. You'll be prompted for your PAT when first using the server")
		
	case "claude-desktop":
		fmt.Println("1. Open Claude Desktop → Settings → Developer → Edit Config")
		fmt.Println("2. Replace <project-ref> with your Supabase project reference")
		fmt.Println("3. Replace <personal-access-token> with your PAT")
		fmt.Println("4. Restart Claude Desktop")
		fmt.Println("5. Look for the hammer (MCP) icon in new chats")
		
	case "claude-code":
		fmt.Println("Option 1 - Project-scoped (.mcp.json file):")
		fmt.Println("  1. Create .mcp.json in your project root")
		fmt.Println("  2. Add the configuration above")
		fmt.Println("  3. Replace <project-ref> and <personal-access-token>")
		fmt.Println()
		fmt.Println("Option 2 - Local-scoped (CLI command):")
		fmt.Println("  claude mcp add supabase -s local -e SUPABASE_ACCESS_TOKEN=<your-token> -- npx -y @supabase/mcp-server-supabase@latest")
		
	case "windsurf":
		fmt.Println("1. Open Windsurf Cascade assistant")
		fmt.Println("2. Click the hammer (MCP) icon → Configure")
		fmt.Println("3. Add the configuration above")
		fmt.Println("4. Replace <project-ref> and <personal-access-token>")
		fmt.Println("5. Save and tap Refresh in Cascade")
		
	case "cline":
		fmt.Println("1. Open Cline extension in VS Code")
		fmt.Println("2. Tap MCP Servers icon → Configure MCP Servers")
		fmt.Println("3. Add the configuration above")
		fmt.Println("4. Replace <project-ref> and <personal-access-token>")
		fmt.Println("5. Cline will auto-reload the configuration")
	}
	
	fmt.Println()
	fmt.Println("📚 Full documentation: https://supabase.com/docs/guides/getting-started/mcp")
}

func getCursorStyleConfig() map[string]interface{} {
	command := "npx"
	args := []interface{}{"-y", "@supabase/mcp-server-supabase@latest", "--read-only", "--project-ref=<project-ref>"}
	
	if runtime.GOOS == "windows" {
		command = "cmd"
		args = append([]interface{}{"/c", "npx"}, args[1:]...)
	}
	
	return map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"supabase": map[string]interface{}{
				"command": command,
				"args":    args,
				"env": map[string]string{
					"SUPABASE_ACCESS_TOKEN": "<personal-access-token>",
				},
			},
		},
	}
}

func getVSCodeConfig() map[string]interface{} {
	command := "npx"
	args := []interface{}{"-y", "@supabase/mcp-server-supabase@latest", "--read-only", "--project-ref=<project-ref>"}
	
	if runtime.GOOS == "windows" {
		command = "cmd"
		args = append([]interface{}{"/c", "npx"}, args[1:]...)
	}
	
	return map[string]interface{}{
		"inputs": []map[string]interface{}{
			{
				"type":        "promptString",
				"id":          "supabase-access-token",
				"description": "Supabase personal access token",
				"password":    true,
			},
		},
		"servers": map[string]interface{}{
			"supabase": map[string]interface{}{
				"command": command,
				"args":    args,
				"env": map[string]string{
					"SUPABASE_ACCESS_TOKEN": "${input:supabase-access-token}",
				},
			},
		},
	}
}

func getClaudeCodeConfig() map[string]interface{} {
	return getCursorStyleConfig() // Same format
}
