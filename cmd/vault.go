package cmd

import (
	"os"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/vault/get"
	"github.com/supabase/cli/internal/vault/update"
)

var (
	vaultCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "vault",
		Short:   "Manage column encryption of Supabase projects",
	}

	rootKeyGetCmd = &cobra.Command{
		Use:   "get-root-key",
		Short: "Get the root encryption key of a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			return get.Run(cmd.Context(), flags.ProjectRef)
		},
	}

	rootKeyUpdateCmd = &cobra.Command{
		Use:   "update-root-key",
		Short: "Update root encryption key of a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			return update.Run(cmd.Context(), flags.ProjectRef, os.Stdin)
		},
	}
)

func init() {
	vaultCmd.PersistentFlags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	vaultCmd.AddCommand(rootKeyUpdateCmd)
	vaultCmd.AddCommand(rootKeyGetCmd)
	rootCmd.AddCommand(vaultCmd)
}
