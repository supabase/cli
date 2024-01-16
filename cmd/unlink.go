package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/unlink"
)

var (
	unlinkCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "unlink",
		Short:   "Unlink to a Supabase project",
		PreRunE: func(cmd *cobra.Command, args []string) error {
			return unlink.PreRun("", afero.NewOsFs())
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			fsys := afero.NewOsFs()
			return unlink.Run(ctx, dbPassword, fsys)
		},
		PostRunE: func(cmd *cobra.Command, args []string) error {
			return unlink.PostRun("", os.Stdout, afero.NewOsFs())
		},
	}
)

func init() {
	rootCmd.AddCommand(unlinkCmd)
}
