package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/db/restore"
)

var (
	migrationName string

	dbCmd = &cobra.Command{
		Use:   "db",
		Short: "Dump or restore the local database.",
	}

	dbDumpCmd = &cobra.Command{
		Use:   "dump",
		Short: "Diffs the local database with current migrations, writing it as a new migration, and writes a new structured dump.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return dump.DbDump(migrationName)
		},
	}

	dbRestoreCmd = &cobra.Command{
		Use:   "restore",
		Short: "Restores the local database to reflect current migrations. Any changes on the local database that is not dumped will be lost.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return restore.DbRestore()
		},
	}
)

func init() {
	dbDumpCmd.Flags().StringVar(&migrationName, "name", "", "Name of the migration.")
	cobra.CheckErr(dbDumpCmd.MarkFlagRequired("name"))

	dbCmd.AddCommand(dbDumpCmd)
	dbCmd.AddCommand(dbRestoreCmd)
	rootCmd.AddCommand(dbCmd)
}
