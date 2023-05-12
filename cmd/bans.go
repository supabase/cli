package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/bans/get"
	"github.com/supabase/cli/internal/bans/update"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	bansCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "network-bans",
		Short:   "Manage network bans",
		Long: `Network bans are IPs that get temporarily blocked if their traffic pattern looks abusive (e.g. multiple failed auth attempts).

The subcommands help you view the current bans, and unblock IPs if desired.`,
	}

	dbIpsToUnban []string

	bansRemoveCmd = &cobra.Command{
		Use:   "remove",
		Short: "Remove a network ban",
		RunE: func(cmd *cobra.Command, args []string) error {
			return update.Run(cmd.Context(), flags.ProjectRef, dbIpsToUnban, afero.NewOsFs())
		},
	}

	bansGetCmd = &cobra.Command{
		Use:   "get",
		Short: "Get the current network bans",
		RunE: func(cmd *cobra.Command, args []string) error {
			return get.Run(cmd.Context(), flags.ProjectRef, afero.NewOsFs())
		},
	}
)

func init() {
	bansCmd.PersistentFlags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	bansCmd.AddCommand(bansGetCmd)
	bansRemoveCmd.Flags().StringSliceVar(&dbIpsToUnban, "db-unban-ip", []string{}, "IP to allow DB connections from.")
	bansCmd.AddCommand(bansRemoveCmd)

	rootCmd.AddCommand(bansCmd)
}
