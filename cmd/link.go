package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/link"
)

var (
	deployDbUrl string

	linkCmd = &cobra.Command{
		Use:   "link",
		Short: "FIXME",
		Long:  `FIXME`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return link.Link(deployDbUrl)
		},
	}
)

func init() {
	linkCmd.Flags().StringVar(&deployDbUrl, "url", "", "FIXME")
	linkCmd.MarkFlagRequired("url")

	rootCmd.AddCommand(linkCmd)
}
