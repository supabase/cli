package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/link"
)

var (
	deployDbUrl string

	linkCmd = &cobra.Command{
		Use:   "link",
		Short: "Link the current project to a remote deploy database.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return link.Link(deployDbUrl)
		},
	}
)

func init() {
	linkCmd.Flags().
		StringVar(&deployDbUrl, "url", "", "Postgres connection string of the deploy database.")
	cobra.CheckErr(linkCmd.MarkFlagRequired("url"))

	rootCmd.AddCommand(linkCmd)
}
