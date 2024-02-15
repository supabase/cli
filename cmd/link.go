package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/utils"
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
			if err := utils.LoadConfigFS(fsys); err != nil {
				return err
			}
			config := flags.GetDbConfigOptionalPassword(flags.ProjectRef)
			return link.Run(ctx, flags.ProjectRef, config, fsys)
		},
		PostRunE: func(cmd *cobra.Command, args []string) error {
			return link.PostRun(flags.ProjectRef, os.Stdout, afero.NewOsFs())
		},
	}
)

func init() {
	linkFlags := linkCmd.Flags()
	linkFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	linkFlags.StringP("password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", linkFlags.Lookup("password")))
	rootCmd.AddCommand(linkCmd)
}
