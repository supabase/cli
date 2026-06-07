package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/orgs/create"
	"github.com/supabase/cli/internal/orgs/list"
)

var (
	orgsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "orgs",
		Short:   "Manage Supabase organizations",
	}

	orgsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all organizations",
		Long:  "List all organizations the logged-in user belongs.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(cmd.Context())
		},
	}

	orgsCreateCmd = &cobra.Command{
		Use:   "create",
		Short: "Create an organization",
		Long:  "Create an organization for the logged-in user.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return create.Run(cmd.Context(), args[0])
		},
	}
)

func init() {
	orgsCmd.AddCommand(orgsListCmd)
	orgsCmd.AddCommand(orgsCreateCmd)
	rootCmd.AddCommand(orgsCmd)
}
