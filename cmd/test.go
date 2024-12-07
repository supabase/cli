package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/test/new"
	"github.com/supabase/cli/internal/utils"
)

var (
	testCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "test",
		Short:   "Run tests on local Supabase containers",
	}

	testDbCmd = &cobra.Command{
		Use:   "db [path] ...",
		Short: dbTestCmd.Short,
		RunE:  dbTestCmd.RunE,
	}

	template = utils.EnumFlag{
		Allowed: []string{new.TemplatePgTAP},
		Value:   new.TemplatePgTAP,
	}

	testNewCmd = &cobra.Command{
		Use:   "new <name>",
		Short: "Create a new test file",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return new.Run(ctx, args[0], template.Value, afero.NewOsFs())
		},
	}
)

func init() {
	// Build db command
	dbFlags := testDbCmd.Flags()
	dbFlags.String("db-url", "", "Tests the database specified by the connection string (must be percent-encoded).")
	dbFlags.Bool("linked", false, "Runs pgTAP tests on the linked project.")
	dbFlags.Bool("local", true, "Runs pgTAP tests on the local database.")
	testDbCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	testCmd.AddCommand(testDbCmd)
	// Build new command
	newFlags := testNewCmd.Flags()
	newFlags.VarP(&template, "template", "t", "Template framework to generate.")
	testCmd.AddCommand(testNewCmd)
	// Build test command
	rootCmd.AddCommand(testCmd)
}
