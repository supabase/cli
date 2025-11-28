# MCP Init - Client Configuration System

This package provides a scalable system for configuring the Supabase MCP server with various AI assistant clients.

## Architecture

The system uses a client registry pattern where each client implements the `Client` interface:

```go
type Client interface {
    Name() string                                      // CLI identifier (e.g., "claude-code")
    DisplayName() string                               // Human-readable name (e.g., "Claude Code")
    IsInstalled() bool                                 // Check if client is installed
    InstallInstructions() string                       // Installation instructions
    Configure(ctx context.Context, fsys afero.Fs) error // Perform configuration
}
```

## Adding a New Client

### Step 1: Implement the Client Interface

Create a new struct that implements the `Client` interface. Here's a complete example:

```go
// cursorClient implements the Client interface for Cursor
type cursorClient struct{}

func (c *cursorClient) Name() string {
    return "cursor"
}

func (c *cursorClient) DisplayName() string {
    return "Cursor"
}

func (c *cursorClient) IsInstalled() bool {
    // Check if cursor command exists or app is installed
    return commandExists("cursor") || appExists("Cursor")
}

func (c *cursorClient) InstallInstructions() string {
    return "Download from https://cursor.sh"
}

func (c *cursorClient) Configure(ctx context.Context, fsys afero.Fs) error {
    fmt.Println("Configuring Cursor...")
    fmt.Println()
    
    // Option 1: Run a CLI command
    cmd := exec.CommandContext(ctx, "cursor", "config", "add", "mcp", "supabase")
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    if err := cmd.Run(); err != nil {
        return fmt.Errorf("failed to configure Cursor: %w", err)
    }
    
    // Option 2: Write a config file
    // configPath := filepath.Join(os.Getenv("HOME"), ".cursor", "mcp.json")
    // ... write JSON config ...
    
    // Option 3: Display manual instructions
    // fmt.Println("Manual setup instructions:")
    // fmt.Println("1. Open Cursor settings...")
    
    fmt.Println("✓ Successfully configured Cursor!")
    return nil
}
```

### Step 2: Register the Client

Add your new client to the `clientRegistry` slice:

```go
var clientRegistry = []Client{
    &claudeCodeClient{},
    &cursorClient{},      // Add your new client here
    &vscodeClient{},      // Add more as needed
}
```

### Step 3: Test

Test the new client:

```bash
# Auto-detect and configure
supabase mcp init

# Or target your specific client
supabase mcp init --client cursor
```

## Configuration Approaches

Depending on the client, you can use different configuration approaches:

### 1. CLI Command Execution

Best for clients with a CLI that supports adding MCP servers:

```go
cmd := exec.CommandContext(ctx, "client-cli", "mcp", "add", "supabase", "https://mcp.supabase.com/mcp")
cmd.Stdout = os.Stdout
cmd.Stderr = os.Stderr
return cmd.Run()
```

### 2. JSON Configuration File

Best for clients that read MCP config from a JSON file:

```go
import (
    "encoding/json"
    "path/filepath"
)

func (c *myClient) Configure(ctx context.Context, fsys afero.Fs) error {
    homeDir, _ := os.UserHomeDir()
    configPath := filepath.Join(homeDir, ".client", "mcp.json")
    
    config := map[string]interface{}{
        "mcpServers": map[string]interface{}{
            "supabase": map[string]interface{}{
                "type": "remote",
                "url":  "https://mcp.supabase.com/mcp",
            },
        },
    }
    
    // Create directory if needed
    if err := fsys.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
        return err
    }
    
    // Read existing config to merge
    existingData, _ := afero.ReadFile(fsys, configPath)
    var existing map[string]interface{}
    if len(existingData) > 0 {
        json.Unmarshal(existingData, &existing)
        // Merge configs...
    }
    
    // Write config
    configJSON, _ := json.MarshalIndent(config, "", "  ")
    return afero.WriteFile(fsys, configPath, configJSON, 0644)
}
```

### 3. Manual Instructions

Best for clients that require manual setup or don't have automation support:

```go
func (c *myClient) Configure(ctx context.Context, fsys afero.Fs) error {
    fmt.Println("Manual Configuration Required")
    fmt.Println("==============================")
    fmt.Println()
    fmt.Println("1. Open Client Settings")
    fmt.Println("2. Navigate to MCP Servers")
    fmt.Println("3. Add the following configuration:")
    fmt.Println()
    fmt.Println(`{
  "supabase": {
    "type": "remote",
    "url": "https://mcp.supabase.com/mcp"
  }
}`)
    fmt.Println()
    fmt.Println("4. Save and restart the client")
    return nil
}
```

## Helper Functions

### `commandExists(command string) bool`

Checks if a command-line tool is available:

```go
if commandExists("cursor") {
    // cursor CLI is available
}
```

### `appExists(appName string) bool` (to be added if needed)

Checks if a macOS application is installed:

```go
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
```

## User Experience Flow

1. **No clients installed**: Shows list of available clients with install instructions
2. **One client installed**: Auto-configures that client
3. **Multiple clients installed**: Shows options and prompts user to choose
4. **Specific client requested**: Configures that client if installed, shows install instructions otherwise

## Examples

See `claudeCodeClient` in `init.go` for a complete working example.
