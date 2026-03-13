package cmd

import (
	"fmt"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/clone"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	cloneCmd = &cobra.Command{
		GroupID: groupQuickStart,
		Use:     "clone",
		Short:   "Clones a Supabase project to your local environment",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			if !viper.IsSet("WORKDIR") {
				title := fmt.Sprintf("Enter a directory to clone your project to (or leave blank to use %s): ", utils.Bold(utils.CurrentDirAbs))
				if workdir, err := utils.NewConsole().PromptText(ctx, title); err != nil {
					return err
				} else {
					viper.Set("WORKDIR", workdir)
				}
			}
			return clone.Run(ctx, afero.NewOsFs())
		},
	}
)

func init() {
	cloneFlags := cloneCmd.Flags()
	cloneFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	rootCmd.AddCommand(cloneCmd)
}
