package cmd

import (
	"fmt"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/utils"
)

var (
	// TODO: allow switching roles on backend
	database = "postgres"
	username = "postgres"

	linkCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "link",
		Short:   "Link to a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			password := viper.GetString("DB_PASSWORD")
			if password == "" {
				password = link.PromptPassword(os.Stdin)
			}

			fsys := afero.NewOsFs()
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			if err := link.Run(ctx, projectRef, username, password, database, fsys); err != nil {
				return err
			}

			fmt.Println("Finished " + utils.Aqua("supabase link") + ".")
			return nil
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
