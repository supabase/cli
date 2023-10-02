package cmd

import (
	"os"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/root_key/get"
	"github.com/supabase/cli/internal/root_key/update"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	rootKeyCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "root-key",
		Short:   "Manage root encryption key",
	}

	rootKeyGetCmd = &cobra.Command{
		Use:   "get",
		Short: "Get the root encryption key of a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			return get.Run(cmd.Context(), flags.ProjectRef)
		},
	}

	rootKeyUpdateCmd = &cobra.Command{
		Use:   "update",
		Short: "Update root encryption key of a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			return update.Run(cmd.Context(), flags.ProjectRef, os.Stdin)
		},
	}
)

func init() {
	rootKeyCmd.PersistentFlags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	rootKeyCmd.AddCommand(rootKeyUpdateCmd)
	rootKeyCmd.AddCommand(rootKeyGetCmd)
	rootCmd.AddCommand(rootKeyCmd)
}
