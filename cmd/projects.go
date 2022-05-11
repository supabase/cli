package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/projects/list"
)

var (
	projectsCmd = &cobra.Command{
		Use:   "projects",
		Short: "Manage Supabase projects",
	}

	projectsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all projects.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run()
		},
	}
)

func init() {
	projectsCmd.AddCommand(projectsListCmd)
	rootCmd.AddCommand(projectsCmd)
}
