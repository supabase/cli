package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
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
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return list.Run(ctx, afero.NewOsFs())
		},
	}
)

func init() {
	orgsCmd.AddCommand(orgsListCmd)
	rootCmd.AddCommand(orgsCmd)
}
