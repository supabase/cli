package cmd

import (
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/declarative"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	declarativeNoCache      bool
	declarativeOverwrite    bool
	declarativeFromMigra    bool
	declarativeToMigrations bool
	declarativeFile         string

	// dbDeclarativeCmd introduces a dedicated command group for declarative workflows.
	//
	// This keeps declarative features discoverable without overloading existing
	// migration-centric db commands.
	dbDeclarativeCmd = &cobra.Command{
		Use:   "declarative",
		Short: "Manage declarative database schemas",
	}

	// dbDeclarativeSyncCmd supports bidirectional sync between migrations and
	// declarative files so users can move between both representations explicitly.
	dbDeclarativeSyncCmd = &cobra.Command{
		Use:   "sync",
		Short: "Sync between migrations and declarative schema",
		RunE: func(cmd *cobra.Command, args []string) error {
			switch {
			case declarativeFromMigra && declarativeToMigrations:
				return errors.New("cannot use --from-migrations and --to-migrations together")
			case !declarativeFromMigra && !declarativeToMigrations:
				return errors.New("must set either --from-migrations or --to-migrations")
			case declarativeFromMigra:
				return declarative.SyncFromMigrations(cmd.Context(), schema, declarativeNoCache, afero.NewOsFs())
			default:
				return declarative.SyncToMigrations(cmd.Context(), schema, declarativeFile, declarativeNoCache, afero.NewOsFs())
			}
		},
	}

	// dbDeclarativeGenerateCmd generates declarative files directly from a live
	// database target. This is the entrypoint for bootstrapping declarative mode.
	dbDeclarativeGenerateCmd = &cobra.Command{
		Use:   "generate",
		Short: "Generate declarative schema from a database",
		RunE: func(cmd *cobra.Command, args []string) error {
			return declarative.Generate(cmd.Context(), schema, flags.DbConfig, declarativeOverwrite, declarativeNoCache, afero.NewOsFs())
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Finished " + utils.Aqua("supabase db declarative generate") + ".")
		},
	}
)

func init() {
	// no-cache allows bypassing catalog snapshots when users need a fresh view of
	// database state, even if cached artifacts are available.
	declarativeFlags := dbDeclarativeCmd.PersistentFlags()
	declarativeFlags.BoolVar(&declarativeNoCache, "no-cache", false, "Disable catalog cache and force fresh shadow database setup.")

	syncFlags := dbDeclarativeSyncCmd.Flags()
	// Sync direction is explicit to prevent accidental destructive behavior.
	syncFlags.BoolVar(&declarativeFromMigra, "from-migrations", false, "Sync declarative schema from local migrations.")
	syncFlags.BoolVar(&declarativeToMigrations, "to-migrations", false, "Generate a new migration to match declarative schema.")
	syncFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	syncFlags.StringVarP(&declarativeFile, "file", "f", "declarative_sync", "Saves schema diff to a new migration file.")

	generateFlags := dbDeclarativeGenerateCmd.Flags()
	generateFlags.BoolVar(&declarativeOverwrite, "overwrite", false, "Overwrite declarative schema files without confirmation.")
	generateFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	generateFlags.String("db-url", "", "Generates declarative schema from the database specified by the connection string (must be percent-encoded).")
	generateFlags.Bool("linked", true, "Generates declarative schema from the linked project.")
	generateFlags.Bool("local", false, "Generates declarative schema from the local database.")
	dbDeclarativeGenerateCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	generateFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", generateFlags.Lookup("password")))

	dbDeclarativeCmd.AddCommand(dbDeclarativeSyncCmd)
	dbDeclarativeCmd.AddCommand(dbDeclarativeGenerateCmd)
	dbCmd.AddCommand(dbDeclarativeCmd)
	experimental = append(experimental, dbDeclarativeCmd)
}
