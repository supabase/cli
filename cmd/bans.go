package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/bans/get"
	"github.com/supabase/cli/internal/bans/update"
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
			fsys := afero.NewOsFs()
			if err := PromptLogin(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return update.Run(ctx, projectRef, dbIpsToUnban, fsys)
		},
	}

	bansGetCmd = &cobra.Command{
		Use:   "get",
		Short: "Get the current network bans",
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
	bansCmd.PersistentFlags().StringVar(&projectRef, "project-ref", "", "Project ref of the Supabase project.")
	bansCmd.AddCommand(bansGetCmd)
	bansRemoveCmd.Flags().StringSliceVar(&dbIpsToUnban, "db-unban-ip", []string{}, "IP to allow DB connections from.")
	bansCmd.AddCommand(bansRemoveCmd)

	rootCmd.AddCommand(bansCmd)
}
