package cmd

import (
	"github.com/spf13/cobra"
)

var (
	testCmd = &cobra.Command{
		GroupID: "local-dev",
		Use:     "test",
		Short:   "Run tests on local Supabase containers",
	}

	testDbCmd = &cobra.Command{
		Use:   "db",
		Short: dbTestCmd.Short,
		RunE:  dbTestCmd.RunE,
	}
)

func init() {
	testCmd.AddCommand(testDbCmd)
	rootCmd.AddCommand(testCmd)
}
