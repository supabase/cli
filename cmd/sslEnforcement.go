package cmd

import (
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/ssl_enforcement/get"
	"github.com/supabase/cli/internal/ssl_enforcement/update"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	sslEnforcementCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "ssl-enforcement",
		Short:   "Manage SSL enforcement configuration",
	}

	dbEnforceSsl bool
	dbDisableSsl bool

	sslEnforcementUpdateCmd = &cobra.Command{
		Use:   "update",
		Short: "Update SSL enforcement configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			if !dbEnforceSsl && !dbDisableSsl {
				return fmt.Errorf("enable/disable not specified")
			}
			return update.Run(cmd.Context(), flags.ProjectRef, dbEnforceSsl, afero.NewOsFs())
		},
	}

	sslEnforcementGetCmd = &cobra.Command{
		Use:   "get",
		Short: "Get the current SSL enforcement configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			return get.Run(cmd.Context(), flags.ProjectRef, afero.NewOsFs())
		},
	}
)

func init() {
	sslEnforcementCmd.PersistentFlags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	sslEnforcementUpdateCmd.Flags().BoolVar(&dbEnforceSsl, "enable-db-ssl-enforcement", false, "Whether the DB should enable SSL enforcement for all external connections.")
	sslEnforcementUpdateCmd.Flags().BoolVar(&dbDisableSsl, "disable-db-ssl-enforcement", false, "Whether the DB should disable SSL enforcement for all external connections.")
	sslEnforcementUpdateCmd.MarkFlagsMutuallyExclusive("enable-db-ssl-enforcement", "disable-db-ssl-enforcement")
	sslEnforcementCmd.AddCommand(sslEnforcementUpdateCmd)
	sslEnforcementCmd.AddCommand(sslEnforcementGetCmd)

	rootCmd.AddCommand(sslEnforcementCmd)
}
