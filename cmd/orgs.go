package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/orgs/list"
)

var (
	orgsCmd = &cobra.Command{
		Use:   "orgs",
		Short: "Manage Supabase organizations",
	}

	orgsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all organizations",
		Long:  "List all organizations the logged-in user belongs.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(afero.NewOsFs())
		},
	}
)

func init() {
	orgsCmd.AddCommand(orgsListCmd)
	rootCmd.AddCommand(orgsCmd)
}
