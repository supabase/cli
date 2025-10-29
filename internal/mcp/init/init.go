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
	ConfigType  string // "cursor", "vscode", "claude-desktop", "claude-code", "windsurf", "cline"
	Detected    bool
	CanAutomate bool // Can we automatically configure this client?
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
				
				// Check if we can automate configuration
				if c.CanAutomate {
					return configureClient(c, fsys)
				} else {
					displayConfigInstructions(c.ConfigType)
				}
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
		fmt.Println("   • cursor       (auto-configurable)")
		fmt.Println("   • vscode       (auto-configurable)")
		fmt.Println("   • claude-code  (auto-configurable via CLI)")
		fmt.Println("   • claude-desktop")
		fmt.Println("   • windsurf")
		fmt.Println("   • cline")
	}

	return nil
}

// configureClient automatically configures the specified client
func configureClient(client ClientConfig, fsys afero.Fs) error {
	fmt.Println("🔧 Auto-configuration mode")
	fmt.Println()
	
	switch client.ConfigType {
	case "cursor", "vscode":
		return configureJSONClient(client, fsys)
	case "claude-code":
		return configureClaudeCode()
	default:
		displayConfigInstructions(client.ConfigType)
		return nil
	}
}

// configureJSONClient creates or updates mcp.json for Cursor/VS Code
func configureJSONClient(client ClientConfig, fsys afero.Fs) error {
	// Prompt for project ref
	fmt.Print("📝 Enter your Supabase project reference (or press Enter to skip): ")
	var projectRef string
	fmt.Scanln(&projectRef)
	
	if projectRef == "" {
		projectRef = "<project-ref>"
		fmt.Println("   ⚠️  You'll need to replace <project-ref> in the config file")
	}
	
	// Determine config directory
	configDir := filepath.Dir(client.ConfigPath)
	configFile := client.ConfigPath
	
	// Check if we should use project-local config
	cwd, _ := os.Getwd()
	var useProjectLocal bool
	
	fmt.Println()
	fmt.Printf("📂 Configuration location options:\n")
	fmt.Printf("   1. Project-local: %s\n", filepath.Join(cwd, filepath.Base(configDir), "mcp.json"))
	fmt.Printf("   2. Global: %s\n", configFile)
	fmt.Print("   Choose (1/2) [1]: ")
	
	var choice string
	fmt.Scanln(&choice)
	
	if choice == "" || choice == "1" {
		useProjectLocal = true
		configDir = filepath.Join(cwd, filepath.Base(configDir))
		configFile = filepath.Join(configDir, "mcp.json")
	}
	
	fmt.Println()
	fmt.Printf("📁 Creating config in: %s\n", configFile)
	
	// Create directory if it doesn't exist
if err := os.MkdirAll(configDir, 0755); err != nil {
return fmt.Errorf("failed to create config directory: %w", err)
}

// Read existing config or create new one
var config map[string]interface{}
existingData, err := os.ReadFile(configFile)
if err == nil {
// Config exists, parse it
if err := json.Unmarshal(existingData, &config); err != nil {
return fmt.Errorf("failed to parse existing config: %w", err)
}
fmt.Println("   ✓ Found existing configuration")
} else {
// Create new config
config = make(map[string]interface{})
fmt.Println("   ✓ Creating new configuration")
}

// Generate the Supabase MCP server config
var supabaseConfig map[string]interface{}
if client.ConfigType == "vscode" {
supabaseConfig = getVSCodeServerConfig(projectRef)
// Ensure inputs array exists
if _, ok := config["inputs"]; !ok {
config["inputs"] = []map[string]interface{}{}
}
// Add input for PAT if not exists
inputs := config["inputs"].([]interface{})
hasInput := false
for _, input := range inputs {
if inputMap, ok := input.(map[string]interface{}); ok {
if inputMap["id"] == "supabase-access-token" {
hasInput = true
break
}
}
}
if !hasInput {
inputs = append(inputs, map[string]interface{}{
"type":        "promptString",
"id":          "supabase-access-token",
"description": "Supabase personal access token",
"password":    true,
})
config["inputs"] = inputs
}
// Add to servers
if _, ok := config["servers"]; !ok {
config["servers"] = make(map[string]interface{})
}
servers := config["servers"].(map[string]interface{})
servers["supabase"] = supabaseConfig
} else {
// Cursor, Windsurf, Cline format
supabaseConfig = getCursorStyleServerConfig(projectRef)
if _, ok := config["mcpServers"]; !ok {
config["mcpServers"] = make(map[string]interface{})
}
mcpServers := config["mcpServers"].(map[string]interface{})
mcpServers["supabase"] = supabaseConfig
}

// Write config file
configJSON, err := json.MarshalIndent(config, "", "  ")
if err != nil {
return fmt.Errorf("failed to marshal config: %w", err)
}

if err := os.WriteFile(configFile, configJSON, 0644); err != nil {
return fmt.Errorf("failed to write config file: %w", err)
}

fmt.Println()
fmt.Println("✅ Configuration complete!")
fmt.Println()
fmt.Printf("📄 Config file: %s\n", configFile)
fmt.Println()

if projectRef == "<project-ref>" {
fmt.Println("⚠️  Next steps:")
fmt.Println("   1. Edit the config file and replace <project-ref> with your project reference")
fmt.Println("   2. Replace <personal-access-token> with your PAT from:")
fmt.Println("      https://supabase.com/dashboard/account/tokens")
} else {
fmt.Println("⚠️  Next steps:")
if client.ConfigType == "vscode" {
fmt.Println("   1. Open Copilot chat and switch to Agent mode")
fmt.Println("   2. You'll be prompted for your PAT when first using the server")
} else {
fmt.Println("   1. Edit the config file and replace <personal-access-token> with your PAT from:")
fmt.Println("      https://supabase.com/dashboard/account/tokens")
fmt.Println("   2. Restart", client.Name)
}
}

if client.ConfigType == "cursor" {
fmt.Println()
fmt.Println("💡 In Cursor, go to Settings → MCP to verify the connection")
}

return nil
}

// configureClaudeCode uses the Claude CLI to configure the server
func configureClaudeCode() error {
fmt.Println("🤖 Claude Code can be configured using the Claude CLI")
fmt.Println()

// Check if claude CLI is available
if _, err := exec.LookPath("claude"); err != nil {
fmt.Println("⚠️  Claude CLI not found in PATH")
fmt.Println()
fmt.Println("Please install the Claude CLI first, or use manual configuration:")
displayConfigInstructions("claude-code")
return nil
}

fmt.Println("✓ Found Claude CLI")
fmt.Println()

// Prompt for configuration
fmt.Print("📝 Enter your Supabase project reference (or press Enter to skip): ")
var projectRef string
fmt.Scanln(&projectRef)

fmt.Print("🔑 Enter your Supabase Personal Access Token (or press Enter to skip): ")
var token string
fmt.Scanln(&token)

if projectRef == "" || token == "" {
fmt.Println()
fmt.Println("⚠️  Project ref or token not provided. Here's the command to run manually:")
fmt.Println()
fmt.Println("   claude mcp add supabase -s local \\")
fmt.Println("     -e SUPABASE_ACCESS_TOKEN=<your-token> \\")
fmt.Println("     -- npx -y @supabase/mcp-server-supabase@latest \\")
fmt.Println("     --read-only --project-ref=<project-ref>")
fmt.Println()
return nil
}

// Build the command
args := []string{
"mcp", "add", "supabase",
"-s", "local",
"-e", fmt.Sprintf("SUPABASE_ACCESS_TOKEN=%s", token),
"--",
"npx", "-y", "@supabase/mcp-server-supabase@latest",
"--read-only",
fmt.Sprintf("--project-ref=%s", projectRef),
}

fmt.Println()
fmt.Println("🚀 Running: claude mcp add supabase...")

cmd := exec.Command("claude", args...)
cmd.Stdout = os.Stdout
cmd.Stderr = os.Stderr

if err := cmd.Run(); err != nil {
return fmt.Errorf("failed to configure Claude Code: %w", err)
}

fmt.Println()
fmt.Println("✅ Claude Code configured successfully!")

return nil
}

// detectClients checks for installed MCP clients
func detectClients() []ClientConfig {
homeDir, _ := os.UserHomeDir()

clients := []ClientConfig{
{
Name:        "Cursor",
ConfigPath:  filepath.Join(homeDir, ".cursor", "mcp.json"),
ConfigType:  "cursor",
CanAutomate: true,
},
{
Name:        "VS Code (Copilot)",
ConfigPath:  filepath.Join(homeDir, ".vscode", "mcp.json"),
ConfigType:  "vscode",
CanAutomate: true,
},
{
Name:        "Claude Desktop",
ConfigPath:  getClaudeDesktopConfigPath(homeDir),
ConfigType:  "claude-desktop",
CanAutomate: false,
},
{
Name:        "Claude Code",
ConfigPath:  filepath.Join(homeDir, ".mcp.json"),
ConfigType:  "claude-code",
CanAutomate: true, // Via CLI
},
{
Name:        "Windsurf",
ConfigPath:  getWindsurfConfigPath(homeDir),
ConfigType:  "windsurf",
CanAutomate: false,
},
{
Name:        "Cline (VS Code)",
ConfigPath:  getClineConfigPath(homeDir),
ConfigType:  "cline",
CanAutomate: false,
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
fmt.Println("📝 Manual Configuration Required")
fmt.Println()
fmt.Println("Configuration Template:")
fmt.Println()

var config interface{}

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
fmt.Println(string(configJSON))
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

func getCursorStyleServerConfig(projectRef string) map[string]interface{} {
command := "npx"
args := []interface{}{"-y", "@supabase/mcp-server-supabase@latest", "--read-only", fmt.Sprintf("--project-ref=%s", projectRef)}

if runtime.GOOS == "windows" {
command = "cmd"
args = append([]interface{}{"/c", "npx"}, args[1:]...)
}

return map[string]interface{}{
"command": command,
"args":    args,
"env": map[string]string{
"SUPABASE_ACCESS_TOKEN": "<personal-access-token>",
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

func getVSCodeServerConfig(projectRef string) map[string]interface{} {
command := "npx"
args := []interface{}{"-y", "@supabase/mcp-server-supabase@latest", "--read-only", fmt.Sprintf("--project-ref=%s", projectRef)}

if runtime.GOOS == "windows" {
command = "cmd"
args = append([]interface{}{"/c", "npx"}, args[1:]...)
}

return map[string]interface{}{
"command": command,
"args":    args,
"env": map[string]string{
"SUPABASE_ACCESS_TOKEN": "${input:supabase-access-token}",
},
}
}

func getClaudeCodeConfig() map[string]interface{} {
return getCursorStyleConfig() // Same format
}
