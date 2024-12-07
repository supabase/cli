package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/postgresConfig/get"
	"github.com/supabase/cli/internal/postgresConfig/update"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	postgresCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "postgres-config",
		Short:   "Manage Postgres database config",
	}

	postgresConfigGetCmd = &cobra.Command{
		Use:   "get",
		Short: "Get the current Postgres database config overrides",
		RunE: func(cmd *cobra.Command, args []string) error {
			return get.Run(cmd.Context(), flags.ProjectRef, afero.NewOsFs())
		},
	}

	postgresConfigUpdateCmd = &cobra.Command{
		Use:   "update",
		Short: "Update Postgres database config",
		Long: `Overriding the default Postgres config could result in unstable database behavior.
Custom configuration also overrides the optimizations generated based on the compute add-ons in use.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return update.Run(cmd.Context(), flags.ProjectRef, postgresConfigValues, postgresConfigUpdateReplaceMode, noRestart, afero.NewOsFs())
		},
	}

	postgresConfigValues            []string
	postgresConfigUpdateReplaceMode bool
	noRestart                       bool
)

func init() {
	postgresCmd.PersistentFlags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	postgresCmd.AddCommand(postgresConfigGetCmd)
	postgresCmd.AddCommand(postgresConfigUpdateCmd)

	updateFlags := postgresConfigUpdateCmd.Flags()
	updateFlags.StringSliceVar(&postgresConfigValues, "config", []string{}, "Config overrides specified as a 'key=value' pair")
	updateFlags.BoolVar(&postgresConfigUpdateReplaceMode, "replace-existing-overrides", false, "If true, replaces all existing overrides with the ones provided. If false (default), merges existing overrides with the ones provided.")
	updateFlags.BoolVar(&noRestart, "no-restart", false, "Do not restart the database after updating config.")

	rootCmd.AddCommand(postgresCmd)
}
