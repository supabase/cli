package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/link"
)

var (
	linkCmd = &cobra.Command{
		Use:   "link",
		Short: "Link to a Supabase project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			projectRef, err := cmd.Flags().GetString("project-ref")
			if err != nil {
				return err
			}

			return link.Run(projectRef)
		},
	}
)

func init() {
	linkCmd.Flags().String("project-ref", "", "Project ref of the Supabase project")
	_ = linkCmd.MarkFlagRequired("project-ref")
	rootCmd.AddCommand(linkCmd)
}
