package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/dev"
)

var devCmd = &cobra.Command{
	GroupID: groupLocalDev,
	Use:     "dev",
	Short:   "Start reactive development mode with multiple workflows",
	Long: `Start a development session that watches for file changes and
automatically applies them to your local environment.

WORKFLOWS:

  schemas   Watch schema files and auto-apply changes to local database
            Configure via [dev.schemas] in config.toml

  seed      Auto-run seeds on startup and when seed files change
            Configure via [dev.seed] in config.toml

  functions (coming soon) Watch and auto-deploy edge functions

The dev command starts the local database if not running, then enables
all configured workflows. Schema changes are applied directly without
creating migration files - use 'supabase db diff -f' when ready to commit.

CONFIGURATION:

  [dev.schemas]
  enabled = true                    # Enable schema workflow (default: true)
  watch = ["schemas/**/*.sql"]      # Glob patterns to watch
  on_change = ""                    # Custom command (e.g., "npx drizzle-kit push")
  types = "src/types/database.ts"   # Auto-generate TypeScript types

  [dev.seed]
  enabled = true                    # Enable seed workflow (default: true)
  on_change = ""                    # Custom command (e.g., "npx prisma db seed")

DEBUG LOGGING:

  DEBUG=supabase:dev:*        All dev logs
  DEBUG=supabase:dev:timing   Timing information
  DEBUG=supabase:dev:watcher  File watcher logs
  DEBUG=supabase:dev:sql      SQL statements being executed

Press Ctrl+C to stop the development session.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return dev.Run(cmd.Context(), afero.NewOsFs())
	},
}

func init() {
	rootCmd.AddCommand(devCmd)
}
