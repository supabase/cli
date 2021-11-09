package cmd

import (
	"errors"
	"os"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/utils"
)

var (
	migrationCmd = &cobra.Command{
		Use:   "migration",
		Short: "Create an empty migration with the `new` subcommand.",
	}

	migrationNewCmd = &cobra.Command{
		Use:   "new",
		Short: "Create an empty migration.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if _, err := os.ReadDir("supabase/migrations"); errors.Is(err, os.ErrNotExist) {
				return errors.New("Cannot find `supabase/migrations` directory. Have you set up the project with `supabase init`?")
			} else if err != nil {
				return err
			}

			timestamp := utils.GetCurrentTimestamp()
			migrationName := args[0]
			return os.WriteFile("supabase/migrations/"+timestamp+"_"+migrationName+".sql", []byte{}, 0644)
		},
	}
)

func init() {
	migrationCmd.AddCommand(migrationNewCmd)
	rootCmd.AddCommand(migrationCmd)
}
