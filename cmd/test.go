package cmd

import (
	"github.com/spf13/cobra"
)

var (
	testCmd = &cobra.Command{
		Use:   "test",
		Short: "Run tests for local project",
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
