package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	mcpinit "github.com/supabase/cli/internal/mcp/init"
)

var (
	mcpInitCmd = &cobra.Command{
		Use:   "init",
		Short: "Initialize MCP server configuration for AI assistants",
		Long: `Interactive setup wizard to configure the Supabase MCP server for your AI assistant clients.

This command will:
  • Guide you through obtaining a Supabase Personal Access Token
  • Securely store your credentials
  • Detect installed MCP clients (Cursor, VS Code, Claude Desktop, etc.)
  • Generate appropriate configuration files for each client
  • Configure server options (read-only mode, project scoping, feature groups)

Examples:
  # Run interactive setup
  supabase mcp init

  # Configure a specific client
  supabase mcp init --client cursor
  supabase mcp init --client vscode
  supabase mcp init --client claude-desktop
  supabase mcp init --client claude-code

  # Skip credential storage and only generate configs
  supabase mcp init --no-save-credentials`,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _ := cmd.Flags().GetString("client")
			return mcpinit.Run(cmd.Context(), afero.NewOsFs(), client)
		},
	}
)

func init() {
	mcpInitCmd.Flags().StringP("client", "c", "", "Target specific client (cursor, vscode, claude-desktop, claude-code, windsurf, cline)")
	mcpCmd.AddCommand(mcpInitCmd)
}
