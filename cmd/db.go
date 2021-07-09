package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/db"
)

var dbCmd = &cobra.Command{
	Use:   "db",
	Short: "TODO",
	Long:  `TODO`,
}

var dbDumpCmd = &cobra.Command{
	Use:   "dump",
	Short: "TODO",
	Long:  `TODO`,
	Run: func(cmd *cobra.Command, args []string) {
		db.DbDump()
	},
}

var dbRestoreCmd = &cobra.Command{
	Use:   "restore",
	Short: "TODO",
	Long:  `TODO`,
	Run: func(cmd *cobra.Command, args []string) {
		db.DbRestore()
	},
}

func init() {
	dbCmd.AddCommand(dbDumpCmd)
	dbCmd.AddCommand(dbRestoreCmd)
	rootCmd.AddCommand(dbCmd)
}
