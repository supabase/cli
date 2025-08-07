package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/snippets/download"
	"github.com/supabase/cli/internal/snippets/list"
	"github.com/supabase/cli/internal/snippets/push"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	snippetsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "snippets",
		Short:   "Manage Supabase SQL snippets",
	}

	snippetsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all SQL snippets",
		Long:  "List all SQL snippets of the linked project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(cmd.Context(), afero.NewOsFs())
		},
	}

	snippetsDownloadCmd = &cobra.Command{
		Use:   "download [snippet-id]",
		Short: "Download one or all SQL snippets",
		Long:  "Download the contents of the specified SQL snippet if an ID is provided. If no ID is supplied, download all snippets into the local project directory.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var snippetId string
			if len(args) > 0 {
				snippetId = args[0]
			}
			return download.Run(cmd.Context(), snippetId, afero.NewOsFs())
		},
	}

    snippetsPushCmd = &cobra.Command{
        Use:   "push",
        Short: "Push local SQL snippets to Supabase",
        Long:  "Create or update SQL snippets from the local supabase/snippets directory to the linked project.",
        RunE: func(cmd *cobra.Command, args []string) error {
            return push.Run(cmd.Context(), afero.NewOsFs())
        },
    }
)

func init() {
	snippetsCmd.PersistentFlags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	snippetsCmd.AddCommand(snippetsListCmd)
	snippetsCmd.AddCommand(snippetsDownloadCmd)
	snippetsCmd.AddCommand(snippetsPushCmd)
	rootCmd.AddCommand(snippetsCmd)
}
