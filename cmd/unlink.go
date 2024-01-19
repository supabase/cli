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
			return cmd.MarkFlagRequired("project-ref")
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			fsys := afero.NewOsFs()
			if err := unlink.PreRun(projectRef, fsys); err != nil {
				return err
			}
			if len(projectRef) == 0 {
				if err := PromptProjectRef(ctx); err != nil {
					return err
				}
			}
			return unlink.Run(ctx, projectRef, fsys)
		},
		PostRunE: func(cmd *cobra.Command, args []string) error {
			return unlink.PostRun("", os.Stdout, afero.NewOsFs())
		},
	}
)

func init() {
	flags := unlinkCmd.Flags()
	flags.StringVar(&projectRef, "project-ref", "", "Project ref of the Supabase project.")
	rootCmd.AddCommand(unlinkCmd)
}
