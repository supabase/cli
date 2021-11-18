package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/db/commit"
	"github.com/supabase/cli/internal/db/reset"
)

var (
	migrationName string

	dbCmd = &cobra.Command{
		Use:   "db",
		Short: "Commit or reset the local database.",
	}

	dbCommitCmd = &cobra.Command{
		Use:   "commit",
		Short: "Diffs the local database with current migrations, writing it as a new migration.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return commit.Run(migrationName)
		},
	}

	dbResetCmd = &cobra.Command{
		Use:   "reset",
		Short: "Resets the local database to reflect current migrations. Any changes on the local database that is not committed will be lost.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return reset.Run()
		},
	}
)

func init() {
	dbCommitCmd.Flags().StringVar(&migrationName, "name", "", "Name of the migration.")
	cobra.CheckErr(dbCommitCmd.MarkFlagRequired("name"))

	dbCmd.AddCommand(dbCommitCmd)
	dbCmd.AddCommand(dbResetCmd)
	rootCmd.AddCommand(dbCmd)
}
