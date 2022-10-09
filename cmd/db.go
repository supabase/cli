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
	"github.com/supabase/cli/internal/db/lint"
	"github.com/supabase/cli/internal/db/push"
	"github.com/supabase/cli/internal/db/remote/changes"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/test"
	"github.com/supabase/cli/internal/utils"
)

var (
	dbCmd = &cobra.Command{
		Use:   "db",
		Short: "Manage local Postgres databases",
	}

	dbBranchCmd = &cobra.Command{
		Use:   "branch",
		Short: "Manage local database branches",
		Long:  "Manage local database branches. Each branch is associated with a separate local database. Forking remote databases is NOT supported.",
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
			if useMigra {
				ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
				return diff.RunMigra(ctx, schema, file, fsys)
			}
			return diff.Run(file, fsys)
		},
	}

	dryRun bool

	dbPushCmd = &cobra.Command{
		Use:   "push",
		Short: "Push new migrations to the remote database",
		RunE: func(cmd *cobra.Command, args []string) error {
			password := viper.GetString("DB_PASSWORD")
			if password == "" {
				password = PromptPassword(os.Stdin)
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return push.Run(ctx, dryRun, username, password, database, afero.NewOsFs())
		},
	}

	dbRemoteCmd = &cobra.Command{
		Use:   "remote",
		Short: "Manage remote databases",
	}

	dbRemoteChangesCmd = &cobra.Command{
		Use:   "changes",
		Short: "Show changes on the remote database",
		Long:  "Show changes on the remote database since last migration.",
		RunE: func(cmd *cobra.Command, args []string) error {
			password := viper.GetString("DB_PASSWORD")
			if password == "" {
				password = PromptPassword(os.Stdin)
			}
			return changes.Run(cmd.Context(), username, password, database, afero.NewOsFs())
		},
	}

	dbRemoteCommitCmd = &cobra.Command{
		Use:   "commit",
		Short: "Commit remote changes as a new migration",
		RunE: func(cmd *cobra.Command, args []string) error {
			password := viper.GetString("DB_PASSWORD")
			if password == "" {
				password = PromptPassword(os.Stdin)
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return commit.Run(ctx, username, password, database, afero.NewOsFs())
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

	dbTestCmd = &cobra.Command{
		Use:   "test",
		Short: "Tests local database with pgTAP.",
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
	diffFlags.StringVarP(&file, "file", "f", "", "Saves schema diff to a file.")
	diffFlags.StringSliceVarP(&schema, "schema", "s", []string{"public"}, "List of schema to include.")
	dbCmd.AddCommand(dbDiffCmd)
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
	// Build test command
	dbCmd.AddCommand(dbTestCmd)
	rootCmd.AddCommand(dbCmd)
}
