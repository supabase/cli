package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/dev"
)

var devCmd = &cobra.Command{
	GroupID: groupLocalDev,
	Use:     "dev",
	Short:   "Start reactive development mode with auto-schema sync",
	Long: `Start a development session that watches for schema changes
and automatically applies them to your local database.

This command:
- Starts the local database if not running
- Watches supabase/schemas/ for changes
- Automatically diffs and applies schema changes
- Does NOT create migration files (use 'supabase db diff -f' for that)

Enable debug logging with DEBUG environment variable:
  DEBUG=supabase:dev:*        - all dev logs
  DEBUG=supabase:dev:timing   - timing information
  DEBUG=supabase:dev:watcher  - file watcher logs
  DEBUG=supabase:dev:sql      - SQL statements being executed

Press Ctrl+C to stop the development session.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return dev.Run(cmd.Context(), afero.NewOsFs())
	},
}

func init() {
	rootCmd.AddCommand(devCmd)
}
