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
	"golang.org/x/term"
)

var (
	// TODO: allow switching roles on backend
	database = "postgres"
	username = "postgres"

	linkCmd = &cobra.Command{
		GroupID: "local-dev",
		Use:     "link",
		Short:   "Link to a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			projectRef, err := cmd.Flags().GetString("project-ref")
			if err != nil {
				return err
			}

			password := viper.GetString("DB_PASSWORD")
			if password == "" {
				password = PromptPassword(os.Stdin)
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
	flags.String("project-ref", "", "Project ref of the Supabase project.")
	flags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", flags.Lookup("password")))
	cobra.CheckErr(linkCmd.MarkFlagRequired("project-ref"))
	rootCmd.AddCommand(linkCmd)
}

func PromptPassword(stdin *os.File) string {
	fmt.Print("Enter your database password: ")
	bytepw, err := term.ReadPassword(int(stdin.Fd()))
	fmt.Println()
	if err != nil {
		return ""
	}
	return string(bytepw)
}
