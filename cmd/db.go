package cmd

import (
	"os"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/db/branch/create"
	"github.com/supabase/cli/internal/db/branch/delete"
	"github.com/supabase/cli/internal/db/branch/list"
	"github.com/supabase/cli/internal/db/branch/switch_"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/push"
	"github.com/supabase/cli/internal/db/remote/changes"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/db/reset"
)

var (
	dbCmd = &cobra.Command{
		Use:   "db",
		Short: "Manage Postgres databases",
	}

	dbBranchCmd = &cobra.Command{
		Use:   "branch",
		Short: "Manage branches. Each branch is associated with a separate database.",
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
			return switch_.Run(args[0])
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
				return diff.RunMigra(cmd.Context(), schema, file, fsys)
			}
			return diff.Run(file, fsys)
		},
	}

	dryRun bool

	dbPushCmd = &cobra.Command{
		Use:   "push",
		Short: "Push new migrations to the remote database",
		RunE: func(cmd *cobra.Command, args []string) error {
			if password == "" {
				password = PromptPassword(os.Stdin)
			}
			return push.Run(cmd.Context(), dryRun, username, password, database, afero.NewOsFs())
		},
	}

	dbRemoteCmd = &cobra.Command{
		Use:   "remote",
		Short: "Manage remote database connections",
	}

	dbRemoteChangesCmd = &cobra.Command{
		Use:   "changes",
		Short: "Print changes on the remote database since the last pushed migration",
		RunE: func(cmd *cobra.Command, args []string) error {
			if password == "" {
				password = PromptPassword(os.Stdin)
			}
			return changes.Run(cmd.Context(), username, password, database, afero.NewOsFs())
		},
	}

	dbRemoteCommitCmd = &cobra.Command{
		Use:   "commit",
		Short: "Commit changes on the remote database since the last pushed migration",
		RunE: func(cmd *cobra.Command, args []string) error {
			if password == "" {
				password = PromptPassword(os.Stdin)
			}
			return commit.Run(cmd.Context(), username, password, database, afero.NewOsFs())
		},
	}

	dbResetCmd = &cobra.Command{
		Use:   "reset",
		Short: "Resets the local database to current migrations",
		RunE: func(cmd *cobra.Command, args []string) error {
			return reset.Run()
		},
	}
)

func init() {
	dbBranchCmd.AddCommand(dbBranchCreateCmd)
	dbBranchCmd.AddCommand(dbBranchDeleteCmd)
	dbBranchCmd.AddCommand(dbBranchListCmd)
	dbBranchCmd.AddCommand(dbSwitchCmd)
	dbCmd.AddCommand(dbBranchCmd)
	dbDiffCmd.Flags().BoolVar(&useMigra, "use-migra", false, "Use migra to generate schema diff.")
	dbDiffCmd.Flags().StringVarP(&file, "file", "f", "", "Saves schema diff to a file.")
	dbDiffCmd.Flags().StringSliceVarP(&schema, "schema", "s", []string{"public"}, "List of schema to include.")
	dbCmd.AddCommand(dbDiffCmd)
	pushFlags := dbPushCmd.Flags()
	pushFlags.BoolVar(&dryRun, "dry-run", false, "Print the migrations that would be applied, but don't actually apply them.")
	// pushFlags.StringVarP(&database, "database", "d", "postgres", "Name of your remote Postgres database.")
	// pushFlags.StringVarP(&username, "username", "u", "postgres", "Username to your remote Postgres database.")
	pushFlags.StringVarP(&password, "password", "p", "", "Password to your remote Postgres database.")
	dbCmd.AddCommand(dbPushCmd)
	dbRemoteCmd.AddCommand(dbRemoteChangesCmd)
	commitFlags := dbRemoteCommitCmd.Flags()
	// commitFlags.StringVarP(&database, "database", "d", "postgres", "Name of your remote Postgres database.")
	// commitFlags.StringVarP(&username, "username", "u", "postgres", "Username to your remote Postgres database.")
	commitFlags.StringVarP(&password, "password", "p", "", "Password to your remote Postgres database.")
	dbRemoteCmd.AddCommand(dbRemoteCommitCmd)
	dbCmd.AddCommand(dbRemoteCmd)
	dbCmd.AddCommand(dbResetCmd)
	rootCmd.AddCommand(dbCmd)
}
