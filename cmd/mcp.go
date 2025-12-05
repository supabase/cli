package cmd

import (
	"github.com/spf13/cobra"
)

var (
	mcpCmd = &cobra.Command{
		GroupID: groupQuickStart,
		Use:     "mcp",
		Short:   "Manage Model Context Protocol (MCP) configuration",
		Long:    "Commands for setting up and managing MCP server configurations for AI assistants like Cursor, VS Code Copilot, and Claude Desktop.",
	}
)

func init() {
	rootCmd.AddCommand(mcpCmd)
}
