package cmd

import (
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

	useMigra bool
	schema   []string
	file     string

	dbDiffCmd = &cobra.Command{
		Use:   "diff",
		Short: "Diffs the local database for schema changes",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if linked {
				if err := loadLinkedProject(fsys); err != nil {
					return err
				}
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			if useMigra {
				return diff.RunMigra(ctx, schema, file, dbPassword, fsys)
			}
			return diff.Run(ctx, schema, file, dbPassword, fsys)
		},
	}

	dbDumpCmd = &cobra.Command{
		Use:   "dump",
		Short: "Dumps schemas from the remote database",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := loadLinkedProject(fsys); err != nil {
				return err
			}
			host := utils.GetSupabaseDbHost(projectRef)
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return dump.Run(ctx, file, username, dbPassword, database, host, fsys)
		},
	}

	dryRun bool

	dbPushCmd = &cobra.Command{
		Use:   "push",
		Short: "Push new migrations to the remote database",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := loadLinkedProject(fsys); err != nil {
				return err
			}
			host := utils.GetSupabaseDbHost(projectRef)
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return push.Run(ctx, dryRun, username, dbPassword, database, host, fsys)
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
			return loadLinkedProject(fsys)
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
			return changes.Run(ctx, username, dbPassword, database, fsys)
		},
	}

	dbRemoteCommitCmd = &cobra.Command{
		Use:   "commit",
		Short: "Commit remote changes as a new migration",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return commit.Run(ctx, username, dbPassword, database, fsys)
		},
	}

	dbResetCmd = &cobra.Command{
		Use:   "reset",
		Short: "Resets the local database to current migrations",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return reset.Run(ctx, afero.NewOsFs())
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
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return lint.Run(ctx, schema, level.Value, afero.NewOsFs())
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
	// Build branch command
	dbBranchCmd.AddCommand(dbBranchCreateCmd)
	dbBranchCmd.AddCommand(dbBranchDeleteCmd)
	dbBranchCmd.AddCommand(dbBranchListCmd)
	dbBranchCmd.AddCommand(dbSwitchCmd)
	dbCmd.AddCommand(dbBranchCmd)
	// Build diff command
	diffFlags := dbDiffCmd.Flags()
	diffFlags.BoolVar(&useMigra, "use-migra", false, "Use migra to generate schema diff.")
	diffFlags.BoolVar(&linked, "linked", false, "Diffs local schema against linked project.")
	diffFlags.StringVarP(&file, "file", "f", "", "Saves schema diff to a new migration file.")
	diffFlags.StringSliceVarP(&schema, "schema", "s", []string{"public"}, "List of schema to include.")
	dbCmd.AddCommand(dbDiffCmd)
	// Build dump command
	dumpFlags := dbDumpCmd.Flags()
	dumpFlags.StringVarP(&file, "file", "f", "", "File path to save the dumped schema.")
	dumpFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", dumpFlags.Lookup("password")))
	dbCmd.AddCommand(dbDumpCmd)
	// Build push command
	pushFlags := dbPushCmd.Flags()
	pushFlags.BoolVar(&dryRun, "dry-run", false, "Print the migrations that would be applied, but don't actually apply them.")
	pushFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", pushFlags.Lookup("password")))
	dbCmd.AddCommand(dbPushCmd)
	// Build remote command
	remoteFlags := dbRemoteCmd.PersistentFlags()
	remoteFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", remoteFlags.Lookup("password")))
	dbRemoteCmd.AddCommand(dbRemoteChangesCmd)
	dbRemoteCmd.AddCommand(dbRemoteCommitCmd)
	dbCmd.AddCommand(dbRemoteCmd)
	// Build reset command
	dbCmd.AddCommand(dbResetCmd)
	// Build lint command
	lintFlags := dbLintCmd.Flags()
	lintFlags.StringSliceVarP(&schema, "schema", "s", []string{"public"}, "List of schema to include.")
	lintFlags.Var(&level, "level", "Error level to emit.")
	dbCmd.AddCommand(dbLintCmd)
	// Build start command
	dbCmd.AddCommand(dbStartCmd)
	// Build test command
	dbCmd.AddCommand(dbTestCmd)
	rootCmd.AddCommand(dbCmd)
}
