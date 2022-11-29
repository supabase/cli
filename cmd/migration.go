package cmd

import (
	"os"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
)

var (
	migrationCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "migration",
		Short:   "Manage database migration scripts",
	}

	migrationListCmd = &cobra.Command{
		Use:   "list",
		Short: "List local and remote migrations",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			projectRef, err := utils.LoadProjectRef(fsys)
			if err != nil {
				return err
			}
			password := getPassword(projectRef)
			host := utils.GetSupabaseDbHost(projectRef)
			return list.Run(cmd.Context(), username, password, database, host, fsys)
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

func getPassword(projectRef string) string {
	if password := viper.GetString("DB_PASSWORD"); len(password) > 0 {
		return password
	}
	if password, err := credentials.Get(projectRef); err == nil {
		return password
	}
	return link.PromptPassword(os.Stdin)
}
