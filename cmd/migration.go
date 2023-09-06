package cmd

import (
	"fmt"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/migration/squash"
	"github.com/supabase/cli/internal/migration/up"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	migrationCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "migration",
		Short:   "Manage database migration scripts",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			cmd.SetContext(ctx)
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
	}

	migrationListCmd = &cobra.Command{
		Use:   "list",
		Short: "List local and remote migrations",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(cmd.Context(), flags.DbConfig, afero.NewOsFs())
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
			return repair.Run(cmd.Context(), flags.DbConfig, args[0], targetStatus.Value, afero.NewOsFs())
		},
	}

	version string

	migrationSquashCmd = &cobra.Command{
		Use:   "squash",
		Short: "Squash migrations to a single file",
		RunE: func(cmd *cobra.Command, args []string) error {
			return squash.Run(cmd.Context(), version, flags.DbConfig, afero.NewOsFs())
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Finished " + utils.Aqua("supabase migration squash") + ".")
		},
	}

	migrationUpCmd = &cobra.Command{
		Use:   "up",
		Short: "Apply pending migrations to local database",
		RunE: func(cmd *cobra.Command, args []string) error {
			return up.Run(cmd.Context(), includeAll, afero.NewOsFs())
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Local database is up to date.")
		},
	}
)

func init() {
	// Build list command
	listFlags := migrationListCmd.Flags()
	listFlags.String("db-url", "", "Lists migrations of the database specified by the connection string (must be percent-encoded).")
	listFlags.Bool("linked", true, "Lists migrations applied to the linked project.")
	listFlags.Bool("local", false, "Lists migrations applied to the local database.")
	migrationListCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	listFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", listFlags.Lookup("password")))
	migrationListCmd.MarkFlagsMutuallyExclusive("db-url", "password")
	migrationCmd.AddCommand(migrationListCmd)
	// Build repair command
	repairFlags := migrationRepairCmd.Flags()
	repairFlags.Var(&targetStatus, "status", "Version status to update.")
	cobra.CheckErr(migrationRepairCmd.MarkFlagRequired("status"))
	repairFlags.String("db-url", "", "Repairs migrations of the database specified by the connection string (must be percent-encoded).")
	repairFlags.Bool("linked", true, "Repairs the migration history of the linked project.")
	repairFlags.Bool("local", false, "Repairs the migration history of the local database.")
	migrationRepairCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	repairFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", repairFlags.Lookup("password")))
	migrationRepairCmd.MarkFlagsMutuallyExclusive("db-url", "password")
	migrationCmd.AddCommand(migrationRepairCmd)
	// Build squash command
	squashFlags := migrationSquashCmd.Flags()
	squashFlags.StringVar(&version, "version", "", "Squash up to the specified version.")
	squashFlags.String("db-url", "", "Squashes migrations of the database specified by the connection string (must be percent-encoded).")
	squashFlags.Bool("linked", false, "Squashes the migration history of the linked project.")
	squashFlags.Bool("local", true, "Squashes the migration history of the local database.")
	migrationSquashCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	squashFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", squashFlags.Lookup("password")))
	migrationSquashCmd.MarkFlagsMutuallyExclusive("db-url", "password")
	migrationCmd.AddCommand(migrationSquashCmd)
	// Build up command
	upFlags := migrationUpCmd.Flags()
	upFlags.BoolVar(&includeAll, "include-all", false, "Include all migrations not found on remote history table.")
	upFlags.String("db-url", "", "Applies migrations to the database specified by the connection string (must be percent-encoded).")
	upFlags.Bool("linked", true, "Applies pending migrations to the linked project.")
	upFlags.Bool("local", false, "Applies pending migrations to the local database.")
	migrationUpCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	migrationCmd.AddCommand(migrationUpCmd)
	// Build new command
	migrationCmd.AddCommand(migrationNewCmd)
	rootCmd.AddCommand(migrationCmd)
}
