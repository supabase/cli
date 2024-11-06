package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/pull_remote"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"golang.org/x/term"
)

var (
	pull_remoteCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "pull_remote",
		Short:   "Link to a Supabase project",
		PreRunE: func(cmd *cobra.Command, args []string) error {
			if !term.IsTerminal(int(os.Stdin.Fd())) && !viper.IsSet("PROJECT_ID") {
				return cmd.MarkFlagRequired("project-ref")
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			// Use an empty fs to skip loading from file
			if err := flags.ParseProjectRef(ctx, afero.NewMemMapFs()); err != nil {
				return err
			}
			fsys := afero.NewOsFs()
			if err := utils.LoadConfigFS(fsys); err != nil {
				return err
			}
			return pull_remote.Run(ctx, flags.ProjectRef, fsys)
		},
	}
)

func init() {
	pull_remoteFlags := pull_remoteCmd.Flags()
	pull_remoteFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	pull_remoteFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	// For some reason, BindPFlag only works for StringVarP instead of StringP
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", pull_remoteFlags.Lookup("password")))
	rootCmd.AddCommand(pull_remoteCmd)
}
