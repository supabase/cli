package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/link"
)

var (
	projectRef string

	linkCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "link",
		Short:   "Link to a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := link.PreRun(projectRef, fsys); err != nil {
				return err
			}
			dbPassword = viper.GetString("DB_PASSWORD")
			if dbPassword == "" {
				dbPassword = link.PromptPasswordAllowBlank(os.Stdin)
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return link.Run(ctx, projectRef, dbPassword, fsys)
		},
		PostRunE: func(cmd *cobra.Command, args []string) error {
			return link.PostRun(projectRef, os.Stdout, afero.NewOsFs())
		},
	}
)

func init() {
	flags := linkCmd.Flags()
	flags.StringVar(&projectRef, "project-ref", "", "Project ref of the Supabase project.")
	flags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", flags.Lookup("password")))
	cobra.CheckErr(linkCmd.MarkFlagRequired("project-ref"))
	rootCmd.AddCommand(linkCmd)
}
