package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/seed"
)

var (
	seedCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "seed",
		Short:   "Generate seed data",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			cmd.SetContext(ctx)
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
	}

	seedAuthCmd = &cobra.Command{
		Use:   "auth",
		Short: "Generate seed data for the Auth schema",
		RunE: func(cmd *cobra.Command, args []string) error {
			return seed.Run(cmd.Context(), afero.NewOsFs())
		},
	}
)

func init() {
	seedCmd.AddCommand(seedAuthCmd)
	rootCmd.AddCommand(seedCmd)
}
