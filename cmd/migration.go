package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/migration/repair"
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
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := loadLinkedProject(fsys); err != nil {
				return err
			}
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			host := utils.GetSupabaseDbHost(projectRef)
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return list.Run(ctx, username, dbPassword, database, host, fsys)
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

	targetStatus = utils.EnumFlag{
		Allowed: []string{
			repair.Applied,
			repair.Reverted,
		},
	}

	migrationRepairCmd = &cobra.Command{
		Use:   "repair <version>",
		Short: "Repairs the migration history table",
		Args:  cobra.ExactArgs(1),
		PersistentPreRunE: func(cmd *cobra.Command, args []string) (err error) {
			fsys := afero.NewOsFs()
			if err := loadLinkedProject(fsys); err != nil {
				return err
			}
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			host := utils.GetSupabaseDbHost(projectRef)
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return repair.Run(ctx, username, dbPassword, database, host, args[0], targetStatus.Value)
		},
	}
)

func init() {
	// Build list command
	listFlags := migrationListCmd.Flags()
	listFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", listFlags.Lookup("password")))
	migrationCmd.AddCommand(migrationListCmd)
	// Build repair command
	repairFlags := migrationRepairCmd.Flags()
	repairFlags.Var(&targetStatus, "status", "Version status to update.")
	cobra.CheckErr(migrationRepairCmd.MarkFlagRequired("status"))
	migrationCmd.AddCommand(migrationRepairCmd)
	// Build new command
	migrationCmd.AddCommand(migrationNewCmd)
	rootCmd.AddCommand(migrationCmd)
}

func loadLinkedProject(fsys afero.Fs) (err error) {
	projectRef, err = utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	dbPassword = getPassword(projectRef)
	return nil
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
