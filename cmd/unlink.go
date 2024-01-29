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
		Short:   "Unlink a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return unlink.Run(ctx, afero.NewOsFs())
		},
	}
)

func init() {
	rootCmd.AddCommand(unlinkCmd)
}
