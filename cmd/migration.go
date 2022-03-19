package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
)

var (
	migrationCmd = &cobra.Command{
		Use:   "migration",
		Short: "Create an empty migration with the " + utils.Aqua("new") + " subcommand.",
	}

	migrationNewCmd = &cobra.Command{
		Use:   "new <migration name>",
		Short: "Create an empty migration.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return new.Run(args[0])
		},
	}
)

func init() {
	migrationCmd.AddCommand(migrationNewCmd)
	rootCmd.AddCommand(migrationCmd)
}
