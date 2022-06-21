package cmd

import (
	"github.com/spf13/cobra"
)

// Passed from `-ldflags`: https://stackoverflow.com/q/11354518.
var version string

var rootCmd = &cobra.Command{
	Use:           "supabase",
	Short:         "Supabase CLI " + version,
	Version:       version,
	SilenceErrors: true,
	SilenceUsage:  true,
}

func Execute() {
	cobra.CheckErr(rootCmd.Execute())
}

func init() {
	rootCmd.SetVersionTemplate("{{.Version}}\n")
}

func NewRootCmd() *cobra.Command {
	// init init
	rootCmd.AddCommand(initCmd)

	// db init
	dbBranchCmd.AddCommand(dbBranchCreateCmd)
	dbBranchCmd.AddCommand(dbBranchDeleteCmd)
	dbBranchCmd.AddCommand(dbBranchListCmd)
	dbCmd.AddCommand(dbBranchCmd)
	dbCmd.AddCommand(dbChangesCmd)
	dbCmd.AddCommand(dbCommitCmd)
	dbCmd.AddCommand(dbPushCmd)
	dbRemoteCmd.AddCommand(dbRemoteSetCmd)
	dbRemoteCmd.AddCommand(dbRemoteChangesCmd)
	dbRemoteCmd.AddCommand(dbRemoteCommitCmd)
	dbCmd.AddCommand(dbRemoteCmd)
	dbCmd.AddCommand(dbResetCmd)
	dbCmd.AddCommand(dbSwitchCmd)
	rootCmd.AddCommand(dbCmd)

	return rootCmd
}
