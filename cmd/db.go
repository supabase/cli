package cmd

import (
	"fmt"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/branch/create"
	"github.com/supabase/cli/internal/db/branch/delete"
	"github.com/supabase/cli/internal/db/branch/list"
	"github.com/supabase/cli/internal/db/branch/switch_"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/db/lint"
	"github.com/supabase/cli/internal/db/push"
	"github.com/supabase/cli/internal/db/remote/changes"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/db/test"
	"github.com/supabase/cli/internal/utils"
)

var (
	dbCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "db",
		Short:   "Manage local Postgres databases",
	}

	dbBranchCmd = &cobra.Command{
		Hidden: true,
		Use:    "branch",
		Short:  "Manage local database branches",
		Long:   "Manage local database branches. Each branch is associated with a separate local database. Forking remote databases is NOT supported.",
	}

	dbBranchCreateCmd = &cobra.Command{
		Use:   "create <branch name>",
		Short: "Create a branch",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return create.Run(args[0], afero.NewOsFs())
		},
	}

	dbBranchDeleteCmd = &cobra.Command{
		Use:   "delete <branch name>",
		Short: "Delete a branch",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return delete.Run(args[0], afero.NewOsFs())
		},
	}

	dbBranchListCmd = &cobra.Command{
		Use:   "list",
		Short: "List branches",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(afero.NewOsFs(), os.Stdout)
		},
	}

	dbSwitchCmd = &cobra.Command{
		Use:   "switch <branch name>",
		Short: "Switch the active branch",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return switch_.Run(ctx, args[0], afero.NewOsFs())
		},
	}

	useMigra   bool
	usePgAdmin bool
	schema     []string
	file       string

	dbDiffCmd = &cobra.Command{
		Use:   "diff",
		Short: "Diffs the local database for schema changes",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if linked || len(dbUrl) > 0 {
				if err := parseDatabaseConfig(fsys); err != nil {
					return err
				}
			} // else use --local, which is the default
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			if usePgAdmin {
				return diff.Run(ctx, schema, file, dbConfig, fsys)
			}
			return diff.RunMigra(ctx, schema, file, dbConfig, fsys)
		},
	}

	dataOnly     bool
	useCopy      bool
	roleOnly     bool
	keepComments bool

	dbDumpCmd = &cobra.Command{
		Use:   "dump",
		Short: "Dumps data or schemas from the remote database",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return dump.Run(ctx, file, dbConfig, schema, dataOnly, roleOnly, keepComments, useCopy, dryRun, fsys)
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			if len(file) > 0 {
				fmt.Fprintln(os.Stderr, "Dumped schema to "+utils.Bold(file)+".")
			}
		},
	}

	dryRun       bool
	includeAll   bool
	includeRoles bool
	includeSeed  bool

	dbPushCmd = &cobra.Command{
		Use:   "push",
		Short: "Push new migrations to the remote database",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := parseDatabaseConfig(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return push.Run(ctx, dryRun, includeAll, includeRoles, includeSeed, dbConfig, fsys)
		},
	}

	dbRemoteCmd = &cobra.Command{
		Use:   "remote",
		Short: "Manage remote databases",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if err := cmd.Root().PersistentPreRunE(cmd, args); err != nil {
				return err
			}
			fsys := afero.NewOsFs()
			return parseDatabaseConfig(fsys)
		},
	}

	dbRemoteChangesCmd = &cobra.Command{
		Deprecated: "use \"db diff --use-migra --linked\" instead.\n",
		Use:        "changes",
		Short:      "Show changes on the remote database",
		Long:       "Show changes on the remote database since last migration.",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return changes.Run(ctx, schema, dbConfig, fsys)
		},
	}

	dbRemoteCommitCmd = &cobra.Command{
		Use:   "commit",
		Short: "Commit remote changes as a new migration",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return commit.Run(ctx, schema, dbConfig, fsys)
		},
	}

	dbResetCmd = &cobra.Command{
		Use:   "reset",
		Short: "Resets the local database to current migrations",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if linked || len(dbUrl) > 0 {
				if err := parseDatabaseConfig(fsys); err != nil {
					return err
				}
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return reset.Run(ctx, version, dbConfig, fsys)
		},
	}

	level = utils.EnumFlag{
		Allowed: lint.AllowedLevels,
		Value:   lint.AllowedLevels[0],
	}

	dbLintCmd = &cobra.Command{
		Use:   "lint",
		Short: "Checks local database for typing error",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if linked || len(dbUrl) > 0 {
				if err := parseDatabaseConfig(fsys); err != nil {
					return err
				}
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return lint.Run(ctx, schema, level.Value, dbConfig, fsys)
		},
	}

	dbStartCmd = &cobra.Command{
		Use:   "start",
		Short: "Starts local Postgres database",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return start.Run(ctx, afero.NewOsFs())
		},
	}

	dbTestCmd = &cobra.Command{
		Hidden: true,
		Use:    "test",
		Short:  "Tests local database with pgTAP",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return test.Run(ctx, afero.NewOsFs())
		},
	}
)

func init() {
	dbCmd.PersistentFlags().StringVar(&dbUrl, "db-url", "", "connect using the specified database url")
	// Build branch command
	dbBranchCmd.AddCommand(dbBranchCreateCmd)
	dbBranchCmd.AddCommand(dbBranchDeleteCmd)
	dbBranchCmd.AddCommand(dbBranchListCmd)
	dbBranchCmd.AddCommand(dbSwitchCmd)
	dbCmd.AddCommand(dbBranchCmd)
	// Build diff command
	diffFlags := dbDiffCmd.Flags()
	diffFlags.BoolVar(&useMigra, "use-migra", true, "Use migra to generate schema diff.")
	diffFlags.BoolVar(&usePgAdmin, "use-pgadmin", false, "Use pgAdmin to generate schema diff.")
	dbDiffCmd.MarkFlagsMutuallyExclusive("use-migra", "use-pgadmin")
	diffFlags.StringVar(&dbUrl, "db-url", "", "Diffs local migration files against the database specified by the connection string (must be percent-encoded).")
	diffFlags.BoolVar(&linked, "linked", false, "Diffs local migration files against the linked project.")
	diffFlags.BoolVar(&local, "local", true, "Diffs local migration files against the local database.")
	dbDiffCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	diffFlags.StringVarP(&file, "file", "f", "", "Saves schema diff to a new migration file.")
	diffFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "List of schema to include.")
	diffFlags.Lookup("schema").DefValue = "all"
	dbCmd.AddCommand(dbDiffCmd)
	// Build dump command
	dumpFlags := dbDumpCmd.Flags()
	dumpFlags.BoolVar(&dryRun, "dry-run", false, "Print the pg_dump script that would be executed.")
	dumpFlags.BoolVar(&dataOnly, "data-only", false, "Dumps only data records.")
	dumpFlags.BoolVar(&useCopy, "use-copy", false, "Uses copy statements in place of inserts.")
	dumpFlags.BoolVar(&roleOnly, "role-only", false, "Dumps only cluster roles.")
	dumpFlags.BoolVar(&keepComments, "keep-comments", false, "Keeps commented lines from pg_dump output.")
	dbDumpCmd.MarkFlagsMutuallyExclusive("data-only", "role-only")
	dumpFlags.StringVarP(&file, "file", "f", "", "File path to save the dumped contents.")
	dumpFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", dumpFlags.Lookup("password")))
	dumpFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "List of schema to include.")
	dumpFlags.Lookup("schema").DefValue = "all"
	dbCmd.AddCommand(dbDumpCmd)
	// Build push command
	pushFlags := dbPushCmd.Flags()
	pushFlags.BoolVar(&includeAll, "include-all", false, "Include all migrations not found on remote history table.")
	pushFlags.BoolVar(&includeRoles, "include-roles", false, "Include custom roles from "+utils.CustomRolesPath+".")
	pushFlags.BoolVar(&includeSeed, "include-seed", false, "Include seed data from "+utils.SeedDataPath+".")
	pushFlags.BoolVar(&dryRun, "dry-run", false, "Print the migrations that would be applied, but don't actually apply them.")
	pushFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", pushFlags.Lookup("password")))
	dbCmd.AddCommand(dbPushCmd)
	// Build remote command
	remoteFlags := dbRemoteCmd.PersistentFlags()
	remoteFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", remoteFlags.Lookup("password")))
	remoteFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "List of schema to include.")
	remoteFlags.Lookup("schema").DefValue = "all"
	dbRemoteCmd.AddCommand(dbRemoteChangesCmd)
	dbRemoteCmd.AddCommand(dbRemoteCommitCmd)
	dbCmd.AddCommand(dbRemoteCmd)
	// Build reset command
	resetFlags := dbResetCmd.Flags()
	resetFlags.BoolVar(&linked, "linked", false, "Resets the linked project to current migrations.")
	resetFlags.StringVar(&version, "version", "", "Reset up to the specified version.")
	dbCmd.AddCommand(dbResetCmd)
	// Build lint command
	lintFlags := dbLintCmd.Flags()
	lintFlags.BoolVar(&linked, "linked", false, "Lints the linked project for schema errors.")
	lintFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "List of schema to include.")
	lintFlags.Lookup("schema").DefValue = "all"
	lintFlags.Var(&level, "level", "Error level to emit.")
	dbCmd.AddCommand(dbLintCmd)
	// Build start command
	dbCmd.AddCommand(dbStartCmd)
	// Build test command
	dbCmd.AddCommand(dbTestCmd)
	rootCmd.AddCommand(dbCmd)
}
