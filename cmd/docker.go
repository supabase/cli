package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/docker/containers/list"
	"github.com/supabase/cli/internal/docker/containers/restart"
)

var (
	containersCmd = &cobra.Command{
		Use:   "containers",
		Short: "Supabase docker containers",
	}

	containersListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all supabase docker containers.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run()
		},
	}

	containersRestartCmd = &cobra.Command{
		Use:   "restart",
		Short: "Restart all supabase docker containers.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return restart.Run()
		},
	}
)

func init() {
	containersCmd.AddCommand(containersListCmd)
	containersCmd.AddCommand(containersRestartCmd)
	rootCmd.AddCommand(containersCmd)
}
