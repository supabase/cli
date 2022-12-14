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
	noPassword = false
	// TODO: allow switching roles on backend
	database = "postgres"
	username = "postgres"

	linkCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "link",
		Short:   "Link to a Supabase project",
		PreRunE: func(cmd *cobra.Command, args []string) error {
			if !viper.GetBool("NO_PASSWORD") {
				dbPassword = viper.GetString("DB_PASSWORD")
				if dbPassword == "" {
					dbPassword = link.PromptPassword(os.Stdin)
				}
			}
			return link.PreRun(projectRef, afero.NewOsFs())
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return link.Run(ctx, projectRef, username, dbPassword, database, fsys)
		},
		PostRunE: func(cmd *cobra.Command, args []string) error {
			return link.PostRun(projectRef, os.Stdout, afero.NewOsFs())
		},
	}
)

func init() {
	flags := linkCmd.Flags()
	flags.StringVar(&projectRef, "project-ref", "", "Project ref of the Supabase project.")
	flags.BoolVarP(&noPassword, "no-password", "w", false, "Never prompt for database password.")
	cobra.CheckErr(viper.BindPFlag("NO_PASSWORD", flags.Lookup("no-password")))
	flags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", flags.Lookup("password")))
	cobra.CheckErr(linkCmd.MarkFlagRequired("project-ref"))
	rootCmd.AddCommand(linkCmd)
}
