package cmd

import (
	"fmt"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/utils"
	"golang.org/x/term"
)

var (
	// TODO: allow switching roles on backend
	database = "postgres"
	username = "postgres"
	password string

	linkCmd = &cobra.Command{
		Use:   "link",
		Short: "Link to a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			projectRef, err := cmd.Flags().GetString("project-ref")
			if err != nil {
				return err
			}

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
	// flags.StringVarP(&database, "database", "d", "postgres", "Name of your remote Postgres database.")
	// flags.StringVarP(&username, "username", "u", "postgres", "Username to your remote Postgres database.")
	flags.StringVarP(&password, "password", "p", "", "Password to your remote Postgres database.")
	_ = linkCmd.MarkFlagRequired("project-ref")
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
