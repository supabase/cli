package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/db/changes"
	"github.com/supabase/cli/internal/db/commit"
	"github.com/supabase/cli/internal/db/push"
	remoteCommit "github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/db/remote/set"
	"github.com/supabase/cli/internal/db/reset"
)

var (
	dbCmd = &cobra.Command{
		Use: "db",
	}

	dbChangesCmd = &cobra.Command{
		Use:   "changes",
		Short: "Diffs the local database with current migrations, then print the diff to standard output.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return changes.Run()
		},
	}

	migrationName string
	dbCommitCmd   = &cobra.Command{
		Use:   "commit",
		Short: "Diffs the local database with current migrations, writing it as a new migration.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return commit.Run(migrationName)
		},
	}

	dbPushCmd = &cobra.Command{
		Use:   "push",
		Short: "Push new migrations to the remote database.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return push.Run()
		},
	}

	dbRemoteCmd = &cobra.Command{
		Use: "remote",
	}

	remoteDbUrl    string
	dbRemoteSetCmd = &cobra.Command{
		Use:   "set",
		Short: "Set the remote database to push migrations to.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return set.Run(remoteDbUrl)
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
)

func init() {
	dbCommitCmd.Flags().StringVar(&migrationName, "name", "", "Name of the migration.")
	cobra.CheckErr(dbCommitCmd.MarkFlagRequired("name"))
	dbRemoteSetCmd.Flags().
		StringVar(&remoteDbUrl, "url", "", "Postgres connection string of the remote database.")
	cobra.CheckErr(dbRemoteSetCmd.MarkFlagRequired("url"))

	dbCmd.AddCommand(dbChangesCmd)
	dbCmd.AddCommand(dbCommitCmd)
	dbCmd.AddCommand(dbPushCmd)
	dbRemoteCmd.AddCommand(dbRemoteSetCmd)
	dbRemoteCmd.AddCommand(dbRemoteCommitCmd)
	dbCmd.AddCommand(dbRemoteCmd)
	dbCmd.AddCommand(dbResetCmd)
	rootCmd.AddCommand(dbCmd)
}
