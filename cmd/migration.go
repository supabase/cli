package cmd

import (
	"fmt"
	"os"
	"os/signal"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/migration/squash"
	"github.com/supabase/cli/internal/migration/up"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
)

var (
	migrationCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "migration",
		Short:   "Manage database migration scripts",
	}

	dbConfig pgconn.Config

	migrationListCmd = &cobra.Command{
		Use:   "list",
		Short: "List local and remote migrations",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return list.Run(ctx, dbConfig, fsys)
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
		Short: "Repair the migration history table",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return repair.Run(ctx, dbConfig, args[0], targetStatus.Value, fsys)
		},
	}

	version string

	migrationSquashCmd = &cobra.Command{
		Use:   "squash",
		Short: "Squash migrations to a single file",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			if linked || len(dbUrl) > 0 {
				if err := parseDatabaseConfig(fsys); err != nil {
					return err
				}
			}
			return squash.Run(ctx, version, dbConfig, fsys)
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Finished " + utils.Aqua("supabase migration squash") + ".")
		},
	}

	migrationUpCmd = &cobra.Command{
		Use:   "up",
		Short: "Apply pending migrations to local database",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return up.Run(ctx, includeAll, afero.NewOsFs())
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Local database is up to date.")
		},
	}
)

func init() {
	// Build list command
	listFlags := migrationListCmd.Flags()
	listFlags.StringVar(&dbUrl, "db-url", "", "connect using the specified database url")
	listFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", listFlags.Lookup("password")))
	migrationListCmd.MarkFlagsMutuallyExclusive("db-url", "password")
	migrationCmd.AddCommand(migrationListCmd)
	// Build repair command
	repairFlags := migrationRepairCmd.Flags()
	repairFlags.Var(&targetStatus, "status", "Version status to update.")
	cobra.CheckErr(migrationRepairCmd.MarkFlagRequired("status"))
	repairFlags.StringVar(&dbUrl, "db-url", "", "connect using the specified database url")
	repairFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", repairFlags.Lookup("password")))
	migrationRepairCmd.MarkFlagsMutuallyExclusive("db-url", "password")
	migrationCmd.AddCommand(migrationRepairCmd)
	// Build squash command
	squashFlags := migrationSquashCmd.Flags()
	squashFlags.StringVar(&version, "version", "", "Squash up to the specified version.")
	squashFlags.StringVar(&dbUrl, "db-url", "", "connect using the specified database url")
	squashFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", squashFlags.Lookup("password")))
	migrationSquashCmd.MarkFlagsMutuallyExclusive("db-url", "password")
	squashFlags.BoolVar(&linked, "linked", false, "Update migration history of the linked project.")
	migrationSquashCmd.MarkFlagsMutuallyExclusive("db-url", "linked")
	migrationCmd.AddCommand(migrationSquashCmd)
	// Build up command
	upFlags := migrationUpCmd.Flags()
	upFlags.BoolVar(&includeAll, "include-all", false, "Include all migrations not found on remote history table.")
	migrationCmd.AddCommand(migrationUpCmd)
	// Build new command
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

func parseDatabaseConfig(fsys afero.Fs) error {
	if len(dbUrl) > 0 {
		config, err := pgconn.ParseConfig(dbUrl)
		if err == nil {
			dbConfig = *config
		}
		return err
	}
	// Load linked project
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	dbPassword = getPassword(projectRef)
	// Initialise connection details for hosted project
	dbConfig.Host = utils.GetSupabaseDbHost(projectRef)
	dbConfig.Port = 6543
	dbConfig.User = "postgres"
	dbConfig.Password = dbPassword
	dbConfig.Database = "postgres"
	return nil
}
