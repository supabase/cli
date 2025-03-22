package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/utils/flags"
	"golang.org/x/term"
)

var (
	linkCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "link",
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
			if err := flags.LoadConfig(fsys); err != nil {
				return err
			}
			// TODO: move this to root cmd
			cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", cmd.Flags().Lookup("password")))
			return link.Run(ctx, flags.ProjectRef, fsys)
		},
	}
)

func init() {
	linkFlags := linkCmd.Flags()
	linkFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	linkFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	// For some reason, BindPFlag only works for StringVarP instead of StringP
	rootCmd.AddCommand(linkCmd)
}
