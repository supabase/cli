package cmd

import (
	"fmt"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/ssl_enforcement/get"
	"github.com/supabase/cli/internal/ssl_enforcement/update"
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
			fsys := afero.NewOsFs()
			if err := PromptLogin(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			if !dbEnforceSsl && !dbDisableSsl {
				return fmt.Errorf("enable/disable not specified")
			}
			return update.Run(ctx, projectRef, dbEnforceSsl, fsys)
		},
	}

	sslEnforcementGetCmd = &cobra.Command{
		Use:   "get",
		Short: "Get the current SSL enforcement configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := PromptLogin(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return get.Run(ctx, projectRef, fsys)
		},
	}
)

func init() {
	sslEnforcementCmd.PersistentFlags().StringVar(&projectRef, "project-ref", "", "Project ref of the Supabase project.")
	sslEnforcementUpdateCmd.Flags().BoolVar(&dbEnforceSsl, "enable-db-ssl-enforcement", false, "Whether the DB should enable SSL enforcement for all external connections.")
	sslEnforcementUpdateCmd.Flags().BoolVar(&dbDisableSsl, "disable-db-ssl-enforcement", false, "Whether the DB should disable SSL enforcement for all external connections.")
	sslEnforcementUpdateCmd.MarkFlagsMutuallyExclusive("enable-db-ssl-enforcement", "disable-db-ssl-enforcement")
	sslEnforcementCmd.AddCommand(sslEnforcementUpdateCmd)
	sslEnforcementCmd.AddCommand(sslEnforcementGetCmd)

	rootCmd.AddCommand(sslEnforcementCmd)
}
