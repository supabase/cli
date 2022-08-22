package cmd

import (
	"os"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/new"
)

var (
	migrationCmd = &cobra.Command{
		Use:   "migration",
		Short: "Manage database migration scripts",
	}

	migrationListCmd = &cobra.Command{
		Use:   "list",
		Short: "List local and remote migrations",
		RunE: func(cmd *cobra.Command, args []string) error {
			password := viper.GetString("DB_PASSWORD")
			if password == "" {
				password = PromptPassword(os.Stdin)
			}
			return list.Run(cmd.Context(), username, password, database, afero.NewOsFs())
		},
	}

	migrationNewCmd = &cobra.Command{
		Use:   "new <migration name>",
		Short: "Create an empty migration script",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return new.Run(args[0], os.Stdin, afero.NewOsFs())
		},
	}
)

func init() {
	flags := migrationListCmd.Flags()
	flags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", flags.Lookup("password")))
	migrationCmd.AddCommand(migrationListCmd)
	migrationCmd.AddCommand(migrationNewCmd)
	rootCmd.AddCommand(migrationCmd)
}
