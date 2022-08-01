package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/branch/create"
	"github.com/supabase/cli/internal/db/branch/delete"
	"github.com/supabase/cli/internal/db/branch/list"
	"github.com/supabase/cli/internal/db/changes"
	"github.com/supabase/cli/internal/db/commit"
	"github.com/supabase/cli/internal/db/push"
	remoteChanges "github.com/supabase/cli/internal/db/remote/changes"
	remoteCommit "github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/db/remote/set"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/switch_"
	"github.com/supabase/cli/internal/debug"
)

var (
	dbCmd = &cobra.Command{
		Use: "db",
	}

	dbBranchCmd = &cobra.Command{
		Use:   "branch",
		Short: "Manage branches. Each branch is associated with a separate database.",
	}

	dbBranchCreateCmd = &cobra.Command{
		Use:   "create <branch name>",
		Short: "Create a branch.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return create.Run(args[0])
		},
	}

	dbBranchDeleteCmd = &cobra.Command{
		Use:   "delete <branch name>",
		Short: "Delete a branch.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return delete.Run(args[0])
		},
	}

	dbBranchListCmd = &cobra.Command{
		Use:   "list",
		Short: "List branches.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run()
		},
	}

	dbChangesCmd = &cobra.Command{
		Use:   "changes",
		Short: "Diffs the local database with current migrations, then print the diff to standard output.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return changes.Run()
		},
	}

	useMigra bool

	dbCommitCmd = &cobra.Command{
		Use:   "commit <migration name>",
		Short: "Diffs the local database with current migrations, writing it as a new migration.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if useMigra {
				return commit.RunMigra(args[0], afero.NewOsFs())
			}
			return commit.Run(args[0])
		},
	}

	dryRun bool

	dbPushCmd = &cobra.Command{
		Use:   "push",
		Short: "Push new migrations to the remote database.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return push.Run(dryRun)
		},
	}

	dbRemoteCmd = &cobra.Command{
		Use: "remote",
	}

	dbRemoteSetCmd = &cobra.Command{
		Use:   "set <remote database url>",
		Short: "Set the remote database to push migrations to.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if viper.GetBool("DEBUG") {
				return set.Run(args[0], afero.NewOsFs(), debug.SetupPGX)
			}
			return set.Run(args[0], afero.NewOsFs())
		},
	}

	dbRemoteChangesCmd = &cobra.Command{
		Use:   "changes",
		Short: "Print changes on the remote database since the last pushed migration.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return remoteChanges.Run()
		},
	}

	dbRemoteCommitCmd = &cobra.Command{
		Use:   "commit",
		Short: "Commit changes on the remote database since the last pushed migration.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return remoteCommit.Run()
		},
	}

	dbResetCmd = &cobra.Command{
		Use:   "reset",
		Short: "Resets the local database to reflect current migrations. Any changes on the local database that is not committed will be lost.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return reset.Run()
		},
	}

	dbSwitchCmd = &cobra.Command{
		Use:   "switch <branch name>",
		Short: "Switch branches.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return switch_.Run(args[0])
		},
	}
)

func init() {
	dbBranchCmd.AddCommand(dbBranchCreateCmd)
	dbBranchCmd.AddCommand(dbBranchDeleteCmd)
	dbBranchCmd.AddCommand(dbBranchListCmd)
	dbCmd.AddCommand(dbBranchCmd)
	dbCmd.AddCommand(dbChangesCmd)
	dbCommitCmd.Flags().BoolVar(&useMigra, "migra", false, "Use migra to generate schema diff.")
	dbCmd.AddCommand(dbCommitCmd)
	dbPushCmd.Flags().BoolVar(&dryRun, "dry-run", false, "Print the migrations that would be applied, but don't actually apply them.")
	dbCmd.AddCommand(dbPushCmd)
	dbRemoteCmd.AddCommand(dbRemoteSetCmd)
	dbRemoteCmd.AddCommand(dbRemoteChangesCmd)
	dbRemoteCmd.AddCommand(dbRemoteCommitCmd)
	dbCmd.AddCommand(dbRemoteCmd)
	dbCmd.AddCommand(dbResetCmd)
	dbCmd.AddCommand(dbSwitchCmd)
	rootCmd.AddCommand(dbCmd)
}
