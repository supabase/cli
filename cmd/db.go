package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/db"
)

var (
	migrationName string

	dbCmd = &cobra.Command{
		Use:   "db",
		Short: "FIXME",
		Long:  `FIXME`,
	}

	dbDumpCmd = &cobra.Command{
		Use:   "dump",
		Short: "FIXME",
		Long:  `FIXME`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return db.DbDump(migrationName)
		},
	}

	dbRestoreCmd = &cobra.Command{
		Use:   "restore",
		Short: "FIXME",
		Long:  `FIXME`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return db.DbRestore()
		},
	}
)

func init() {
	dbDumpCmd.Flags().StringVar(&migrationName, "name", "", "FIXME")
	dbDumpCmd.MarkFlagRequired("name")

	dbCmd.AddCommand(dbDumpCmd)
	dbCmd.AddCommand(dbRestoreCmd)
	rootCmd.AddCommand(dbCmd)
}
