package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	mcpinit "github.com/supabase/cli/internal/mcp/init"
)

var (
	mcpInitCmd = &cobra.Command{
		Use:   "init",
		Short: "Configure Supabase MCP server for AI assistant clients",
		Long: `Configure the Supabase MCP server for your AI assistant clients.

This command will detect installed MCP clients and guide you through the setup process.
Currently supports: Claude Code (with more clients coming soon).

The Supabase MCP server allows AI assistants to interact with your Supabase projects,
providing tools for database operations, edge functions, storage, and more.

Examples:
  # Auto-detect and configure installed clients
  supabase mcp init

  # Configure a specific client
  supabase mcp init --client claude-code`,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _ := cmd.Flags().GetString("client")
			return mcpinit.Run(cmd.Context(), afero.NewOsFs(), client)
		},
	}
)

func init() {
	mcpInitCmd.Flags().StringP("client", "c", "", "Target specific client (e.g., claude-code)")
	mcpCmd.AddCommand(mcpInitCmd)
}
