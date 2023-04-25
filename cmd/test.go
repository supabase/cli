package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/test/new"
)

var (
	testCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "test",
		Short:   "Run tests on local Supabase containers",
	}

	testDbCmd = &cobra.Command{
		Use:   "db",
		Short: dbTestCmd.Short,
		RunE:  dbTestCmd.RunE,
	}

	testNewCmd = &cobra.Command{
		Use:   "new <name>",
		Short: "Create a new pgTAP test",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return new.Run(ctx, args[0], afero.NewOsFs())
		},
	}
)

func init() {
	testCmd.AddCommand(testDbCmd)
	testCmd.AddCommand(testNewCmd)
	rootCmd.AddCommand(testCmd)
}
