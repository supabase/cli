package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/legacy/branch/create"
	"github.com/supabase/cli/legacy/branch/delete"
	"github.com/supabase/cli/legacy/branch/list"
	"github.com/supabase/cli/legacy/branch/switch_"
)

var (
	dbCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "db",
		Short:   "Manage Postgres databases",
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

	// Bound so the TS `--use-pg-schema` proxy can forward these without unknown-flag errors.
	usePgSchema bool
	outputPath  string
	schema      []string
	file        string
	dbPassword  string

	dbDiffCmd = &cobra.Command{
		Use:   "diff",
		Short: "Diffs the local database for schema changes",
		RunE: func(cmd *cobra.Command, args []string) error {
			// TypeScript only proxies `--use-pg-schema` (stripe/pg-schema-diff).
			// Other engines run in-process in the TS CLI.
			fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "--use-pg-schema flag is experimental and may not include all entities, such as views and grants.")
			return diff.Run(cmd.Context(), schema, file, flags.DbConfig, diff.DiffPgSchema, afero.NewOsFs())
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
			return diff.Run(cmd.Context(), schema, file, flags.DbConfig, diff.DiffSchemaMigra, afero.NewOsFs())
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
	diffFlags.BoolVar(&usePgSchema, "use-pg-schema", false, "Use pg-schema-diff to generate schema diff.")
	diffFlags.StringVarP(&outputPath, "output", "o", "", "Write explicit diff output to a file path.")
	diffFlags.String("db-url", "", "Diffs against the database specified by the connection string (must be percent-encoded).")
	diffFlags.Bool("linked", false, "Diffs local migration files against the linked project.")
	diffFlags.Bool("local", true, "Diffs local migration files against the local database.")
	dbDiffCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	diffFlags.StringVarP(&file, "file", "f", "", "Saves schema diff to a new migration file.")
	diffFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	dbCmd.AddCommand(dbDiffCmd)
	// Build remote command
	remoteFlags := dbRemoteCmd.PersistentFlags()
	remoteFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	remoteFlags.String("db-url", "", "Connect using the specified Postgres URL (must be percent-encoded).")
	remoteFlags.Bool("linked", true, "Connect to the linked project.")
	dbRemoteCmd.MarkFlagsMutuallyExclusive("db-url", "linked")
	remoteFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", remoteFlags.Lookup("password")))
	dbRemoteCmd.AddCommand(dbRemoteChangesCmd)
	dbCmd.AddCommand(dbRemoteCmd)
	rootCmd.AddCommand(dbCmd)
}
