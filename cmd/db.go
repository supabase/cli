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
	"github.com/supabase/cli/internal/db/pull"
	"github.com/supabase/cli/internal/db/push"
	"github.com/supabase/cli/internal/db/remote/changes"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/db/test"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	dbCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "db",
		Short:   "Manage Postgres databases",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			cmd.SetContext(ctx)
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
	}

	dbBranchCmd = &cobra.Command{
		Hidden: true,
		Use:    "branch",
		Short:  "Manage local database branches",
		Long:   "Manage local database branches. Each branch is associated with a separate local database. Forking remote databases is NOT supported.",
	}

	dbBranchCreateCmd = &cobra.Command{
		Deprecated: "use \"branches create <name>\" instead.\n",
		Use:        "create <branch name>",
		Short:      "Create a branch",
		Args:       cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return create.Run(args[0], afero.NewOsFs())
		},
	}

	dbBranchDeleteCmd = &cobra.Command{
		Deprecated: "use \"branches delete <branch-id>\" instead.\n",
		Use:        "delete <branch name>",
		Short:      "Delete a branch",
		Args:       cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return delete.Run(args[0], afero.NewOsFs())
		},
	}

	dbBranchListCmd = &cobra.Command{
		Deprecated: "use \"branches list\" instead.\n",
		Use:        "list",
		Short:      "List branches",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(afero.NewOsFs(), os.Stdout)
		},
	}

	dbSwitchCmd = &cobra.Command{
		Deprecated: "use \"branches create <name>\" instead.\n",
		Use:        "switch <branch name>",
		Short:      "Switch the active branch",
		Args:       cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return switch_.Run(cmd.Context(), args[0], afero.NewOsFs())
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
			if usePgAdmin {
				return diff.Run(cmd.Context(), schema, file, flags.DbConfig, afero.NewOsFs())
			}
			return diff.RunMigra(cmd.Context(), schema, file, flags.DbConfig, afero.NewOsFs())
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
			return dump.Run(cmd.Context(), file, flags.DbConfig, schema, dataOnly, roleOnly, keepComments, useCopy, dryRun, afero.NewOsFs())
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
			return push.Run(cmd.Context(), dryRun, includeAll, includeRoles, includeSeed, flags.DbConfig, afero.NewOsFs())
		},
	}

	dbPullCmd = &cobra.Command{
		Use:   "pull [migration name]",
		Short: "Pull schema from the remote database",
		RunE: func(cmd *cobra.Command, args []string) error {
			name := "remote_schema"
			if len(args) > 0 {
				name = args[0]
			}
			return pull.Run(cmd.Context(), schema, flags.DbConfig, name, afero.NewOsFs())
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Finished " + utils.Aqua("supabase db pull") + ".")
		},
	}

	dbRemoteCmd = &cobra.Command{
		Hidden: true,
		Use:    "remote",
		Short:  "Manage remote databases",
	}

	dbRemoteChangesCmd = &cobra.Command{
		Deprecated: "use \"db diff --use-migra --linked\" instead.\n",
		Use:        "changes",
		Short:      "Show changes on the remote database",
		Long:       "Show changes on the remote database since last migration.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return changes.Run(cmd.Context(), schema, flags.DbConfig, afero.NewOsFs())
		},
	}

	dbRemoteCommitCmd = &cobra.Command{
		Deprecated: "use \"db pull\" instead.\n",
		Use:        "commit",
		Short:      "Commit remote changes as a new migration",
		RunE: func(cmd *cobra.Command, args []string) error {
			return commit.Run(cmd.Context(), schema, flags.DbConfig, afero.NewOsFs())
		},
	}

	dbResetCmd = &cobra.Command{
		Use:   "reset",
		Short: "Resets the local database to current migrations",
		RunE: func(cmd *cobra.Command, args []string) error {
			return reset.Run(cmd.Context(), migrationVersion, flags.DbConfig, afero.NewOsFs())
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
			return lint.Run(cmd.Context(), schema, level.Value, flags.DbConfig, afero.NewOsFs())
		},
	}

	dbStartCmd = &cobra.Command{
		Use:   "start",
		Short: "Starts local Postgres database",
		RunE: func(cmd *cobra.Command, args []string) error {
			return start.Run(cmd.Context(), afero.NewOsFs())
		},
	}

	dbTestCmd = &cobra.Command{
		Hidden: true,
		Use:    "test",
		Short:  "Tests local database with pgTAP",
		RunE: func(cmd *cobra.Command, args []string) error {
			return test.Run(cmd.Context(), afero.NewOsFs())
		},
	}
)

func init() {
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
	diffFlags.String("db-url", "", "Diffs against the database specified by the connection string (must be percent-encoded).")
	diffFlags.Bool("linked", false, "Diffs local migration files against the linked project.")
	diffFlags.Bool("local", true, "Diffs local migration files against the local database.")
	dbDiffCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	diffFlags.StringVarP(&file, "file", "f", "", "Saves schema diff to a new migration file.")
	diffFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	dbCmd.AddCommand(dbDiffCmd)
	// Build dump command
	dumpFlags := dbDumpCmd.Flags()
	dumpFlags.BoolVar(&dryRun, "dry-run", false, "Prints the pg_dump script that would be executed.")
	dumpFlags.BoolVar(&dataOnly, "data-only", false, "Dumps only data records.")
	dumpFlags.BoolVar(&useCopy, "use-copy", false, "Uses copy statements in place of inserts.")
	dumpFlags.BoolVar(&roleOnly, "role-only", false, "Dumps only cluster roles.")
	dumpFlags.BoolVar(&keepComments, "keep-comments", false, "Keeps commented lines from pg_dump output.")
	dbDumpCmd.MarkFlagsMutuallyExclusive("data-only", "role-only")
	dumpFlags.StringVarP(&file, "file", "f", "", "File path to save the dumped contents.")
	dumpFlags.String("db-url", "", "Dumps from the database specified by the connection string (must be percent-encoded).")
	dumpFlags.Bool("linked", true, "Dumps from the linked project.")
	dumpFlags.Bool("local", false, "Dumps from the local database.")
	dbDumpCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	dumpFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", dumpFlags.Lookup("password")))
	dumpFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	dbCmd.AddCommand(dbDumpCmd)
	// Build push command
	pushFlags := dbPushCmd.Flags()
	pushFlags.BoolVar(&includeAll, "include-all", false, "Include all migrations not found on remote history table.")
	pushFlags.BoolVar(&includeRoles, "include-roles", false, "Include custom roles from "+utils.CustomRolesPath+".")
	pushFlags.BoolVar(&includeSeed, "include-seed", false, "Include seed data from "+utils.SeedDataPath+".")
	pushFlags.BoolVar(&dryRun, "dry-run", false, "Print the migrations that would be applied, but don't actually apply them.")
	pushFlags.String("db-url", "", "Pushes to the database specified by the connection string (must be percent-encoded).")
	pushFlags.Bool("linked", true, "Pushes to the linked project.")
	pushFlags.Bool("local", false, "Pushes to the local database.")
	dbPushCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	pushFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", pushFlags.Lookup("password")))
	dbCmd.AddCommand(dbPushCmd)
	// Build pull command
	pullFlags := dbPullCmd.Flags()
	pullFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	pullFlags.String("db-url", "", "Pulls from the database specified by the connection string (must be percent-encoded).")
	pullFlags.Bool("linked", true, "Pulls from the linked project.")
	pullFlags.Bool("local", false, "Pulls from the local database.")
	dbPullCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	pullFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", pullFlags.Lookup("password")))
	dbCmd.AddCommand(dbPullCmd)
	// Build remote command
	remoteFlags := dbRemoteCmd.PersistentFlags()
	remoteFlags.String("db-url", "", "Connect using the specified Postgres URL (must be percent-encoded).")
	remoteFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", remoteFlags.Lookup("password")))
	remoteFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	dbRemoteCmd.AddCommand(dbRemoteChangesCmd)
	dbRemoteCmd.AddCommand(dbRemoteCommitCmd)
	dbCmd.AddCommand(dbRemoteCmd)
	// Build reset command
	resetFlags := dbResetCmd.Flags()
	resetFlags.String("db-url", "", "Resets the database specified by the connection string (must be percent-encoded).")
	resetFlags.Bool("linked", false, "Resets the linked project to current migrations.")
	resetFlags.Bool("local", true, "Resets the local database to current migrations.")
	dbResetCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	resetFlags.StringVar(&migrationVersion, "version", "", "Reset up to the specified version.")
	dbCmd.AddCommand(dbResetCmd)
	// Build lint command
	lintFlags := dbLintCmd.Flags()
	lintFlags.String("db-url", "", "Lints the database specified by the connection string (must be percent-encoded).")
	lintFlags.Bool("linked", false, "Lints the linked project for schema errors.")
	lintFlags.Bool("local", true, "Lints the local database for schema errors.")
	dbLintCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	lintFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	lintFlags.Var(&level, "level", "Error level to emit.")
	dbCmd.AddCommand(dbLintCmd)
	// Build start command
	dbCmd.AddCommand(dbStartCmd)
	// Build test command
	dbCmd.AddCommand(dbTestCmd)
	rootCmd.AddCommand(dbCmd)
}
