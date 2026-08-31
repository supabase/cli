package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/pull"
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

	useMigra       bool
	usePgAdmin     bool
	usePgSchema    bool
	usePgDelta     bool
	useDeclarative bool
	pullDiffEngine = utils.EnumFlag{
		Allowed: []string{"migra", "pg-delta"},
		Value:   "migra",
	}
	diffFrom   string
	diffTo     string
	outputPath string
	schema     []string
	file       string
	dbPassword string

	dbDiffCmd = &cobra.Command{
		Use:   "diff",
		Short: "Diffs the local database for schema changes",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(diffFrom) > 0 || len(diffTo) > 0 {
				switch {
				case len(diffFrom) == 0 || len(diffTo) == 0:
					return fmt.Errorf("must set both --from and --to when using explicit diff mode")
				default:
					return diff.RunExplicit(cmd.Context(), diffFrom, diffTo, schema, outputPath, afero.NewOsFs())
				}
			}
			useDelta := resolveDiffEngine(cmd.Flags().Changed("use-migra"), usePgAdmin, usePgSchema, shouldUsePgDelta())
			if usePgAdmin {
				return diff.RunPgAdmin(cmd.Context(), schema, file, flags.DbConfig, afero.NewOsFs())
			}
			differ := diff.DiffSchemaMigra
			if usePgSchema {
				differ = diff.DiffPgSchema
				fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "--use-pg-schema flag is experimental and may not include all entities, such as views and grants.")
			} else if useDelta {
				differ = diff.DiffPgDelta
			}
			return diff.Run(cmd.Context(), schema, file, flags.DbConfig, differ, useDelta, afero.NewOsFs())
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
			// Declarative export is opt-in via --declarative. Enabling pg-delta in config
			// does not switch db pull to declarative output; it keeps the migration-file
			// workflow and only defaults the shadow diff engine below.
			useDeclarativePgDelta := useDeclarative
			usePgDeltaDiff := resolvePullDiffEngine(
				cmd.Flags().Changed("diff-engine"),
				pullDiffEngine.Value,
				shouldUsePgDelta(),
			)
			pullDiffer := diff.DiffSchemaMigra
			if usePgDeltaDiff {
				pullDiffer = diff.DiffPgDelta
			}
			return pull.Run(cmd.Context(), schema, flags.DbConfig, name, useDeclarativePgDelta, usePgDeltaDiff, pullDiffer, afero.NewOsFs())
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
			return diff.Run(cmd.Context(), schema, file, flags.DbConfig, diff.DiffSchemaMigra, false, afero.NewOsFs())
		},
	}

	dbRemoteCommitCmd = &cobra.Command{
		Deprecated: "use \"db pull\" instead.\n",
		Use:        "commit",
		Short:      "Commit remote changes as a new migration",
		RunE: func(cmd *cobra.Command, args []string) error {
			// remote commit always writes a timestamped migration file. When pg-delta is
			// enabled it only swaps the shadow diff engine; it never switches to the
			// declarative export path.
			usePgDeltaDiff := shouldUsePgDelta()
			pullDiffer := diff.DiffSchemaMigra
			if usePgDeltaDiff {
				pullDiffer = diff.DiffPgDelta
			}
			return pull.Run(cmd.Context(), schema, flags.DbConfig, "remote_commit", false, usePgDeltaDiff, pullDiffer, afero.NewOsFs())
		},
	}
)

// pg-delta is the default engine; an explicit `[experimental.pgdelta] enabled = false`
// is the rollback, overridable per run by --use-pg-delta. The historical
// SUPABASE_EXPERIMENTAL_PG_DELTA opt-in env var is no longer consulted so the
// config rollback stays authoritative.
func shouldUsePgDelta() bool {
	return utils.IsPgDeltaEnabled() || usePgDelta
}

// resolveDiffEngine reports whether `db diff` should run in pg-delta mode. The config /
// env default (pgDeltaDefault) applies unless an explicit non-pg-delta engine is selected:
// --use-migra, --use-pgadmin, or --use-pg-schema is an authoritative rollback that clears
// pg-delta mode so diff.Run skips pg-delta-specific declarative shadow setup and the
// PGDELTA_DEBUG capture path. --use-migra is off unless passed, so only an explicit pass
// (useMigraChanged) counts as opting out.
func resolveDiffEngine(useMigraChanged, usePgAdmin, usePgSchema, pgDeltaDefault bool) bool {
	if useMigraChanged || usePgAdmin || usePgSchema {
		return false
	}
	return pgDeltaDefault
}

// resolvePullDiffEngine selects whether migration-style db pull uses pg-delta for the
// shadow diff step. An explicit --diff-engine flag always wins, so --diff-engine migra is
// an authoritative rollback even when pg-delta is enabled in config; otherwise the default
// follows whether pg-delta is the active engine (config / env).
func resolvePullDiffEngine(engineFlagChanged bool, engine string, pgDeltaDefault bool) bool {
	if engineFlagChanged {
		return engine == "pg-delta"
	}
	return pgDeltaDefault
}

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
	diffFlags.BoolVar(&usePgAdmin, "use-pgadmin", false, "Use pgAdmin to generate schema diff.")
	diffFlags.BoolVar(&usePgSchema, "use-pg-schema", false, "Use pg-schema-diff to generate schema diff.")
	diffFlags.BoolVar(&usePgDelta, "use-pg-delta", false, "Use pg-delta to generate schema diff.")
	dbDiffCmd.MarkFlagsMutuallyExclusive("use-migra", "use-pgadmin", "use-pg-schema", "use-pg-delta")
	diffFlags.StringVar(&diffFrom, "from", "", "Diff from local, linked, migrations, or a Postgres URL.")
	diffFlags.StringVar(&diffTo, "to", "", "Diff to local, linked, migrations, or a Postgres URL.")
	diffFlags.StringVarP(&outputPath, "output", "o", "", "Write explicit diff output to a file path.")
	diffFlags.String("db-url", "", "Diffs against the database specified by the connection string (must be percent-encoded).")
	diffFlags.Bool("linked", false, "Diffs local migration files against the linked project.")
	diffFlags.Bool("local", true, "Diffs local migration files against the local database.")
	dbDiffCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	diffFlags.StringVarP(&file, "file", "f", "", "Saves schema diff to a new migration file.")
	diffFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	dbCmd.AddCommand(dbDiffCmd)
	// Build pull command
	pullFlags := dbPullCmd.Flags()
	// --declarative switches pull output from a timestamped migration to declarative
	// schema files exported through pg-delta. --use-pg-delta is the deprecated alias.
	pullFlags.BoolVar(&useDeclarative, "declarative", false, "Pull schema as declarative files using pg-delta instead of creating a migration.")
	pullFlags.BoolVar(&useDeclarative, "use-pg-delta", false, "Use pg-delta to pull declarative schema.")
	cobra.CheckErr(pullFlags.MarkDeprecated("use-pg-delta", "use --declarative with [experimental.pgdelta] enabled = true in your config.toml instead."))
	pullFlags.Var(&pullDiffEngine, "diff-engine", "Diff engine to use for migration-style db pull.")
	pullFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	pullFlags.String("db-url", "", "Pulls from the database specified by the connection string (must be percent-encoded).")
	pullFlags.Bool("linked", true, "Pulls from the linked project.")
	pullFlags.Bool("local", false, "Pulls from the local database.")
	dbPullCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	dbPullCmd.MarkFlagsMutuallyExclusive("declarative", "diff-engine")
	dbPullCmd.MarkFlagsMutuallyExclusive("use-pg-delta", "diff-engine")
	pullFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", pullFlags.Lookup("password")))
	dbCmd.AddCommand(dbPullCmd)
	// Build remote command
	remoteFlags := dbRemoteCmd.PersistentFlags()
	remoteFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	remoteFlags.String("db-url", "", "Connect using the specified Postgres URL (must be percent-encoded).")
	remoteFlags.Bool("linked", true, "Connect to the linked project.")
	dbRemoteCmd.MarkFlagsMutuallyExclusive("db-url", "linked")
	remoteFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", remoteFlags.Lookup("password")))
	dbRemoteCmd.AddCommand(dbRemoteChangesCmd)
	dbRemoteCmd.AddCommand(dbRemoteCommitCmd)
	dbCmd.AddCommand(dbRemoteCmd)
	rootCmd.AddCommand(dbCmd)
}
