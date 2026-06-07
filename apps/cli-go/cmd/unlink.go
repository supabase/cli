package cmd

import (
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
			return unlink.Run(cmd.Context(), afero.NewOsFs())
		},
	}
)

func init() {
	rootCmd.AddCommand(unlinkCmd)
}
