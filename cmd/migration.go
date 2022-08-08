package cmd

import (
	"os"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/migration/new"
)

var (
	migrationCmd = &cobra.Command{
		Use:   "migration",
		Short: "Manage database migration scripts",
	}

	migrationNewCmd = &cobra.Command{
		Use:   "new <migration name>",
		Short: "Create an empty migration script",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return new.Run(args[0], os.Stdin, afero.NewOsFs())
		},
	}
)

func init() {
	migrationCmd.AddCommand(migrationNewCmd)
	rootCmd.AddCommand(migrationCmd)
}
